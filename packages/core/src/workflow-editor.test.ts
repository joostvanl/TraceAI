import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_AGENT_POLICY,
  DEFAULT_STAGES,
} from "./types.js";
import {
  applyEdgesToStages,
  applyTicketTemplate,
  canvasToPendingDraft,
  computeMigrationImpact,
  defaultEditorLayout,
  documentToCanvas,
  getEdgeScopedRules,
  setEdgeScopedRules,
  stagesToEdges,
  validateMigrationMap,
  validateWorkflowDocument,
} from "./workflow-editor.js";

describe("validateWorkflowDocument", () => {
  it("accepts the default product workflow", () => {
    const issues = validateWorkflowDocument({
      stages: DEFAULT_STAGES,
      agent_policy: DEFAULT_AGENT_POLICY,
    });
    assert.equal(issues.length, 0);
  });

  it("rejects duplicate keys and unknown transitions", () => {
    const issues = validateWorkflowDocument({
      agent_policy: DEFAULT_AGENT_POLICY,
      stages: [
        { key: "a", name: "A", transitions: ["missing"] },
        { key: "a", name: "A2", transitions: [] },
      ],
    });
    assert.ok(issues.some((i) => i.code === "DUPLICATE_KEY"));
    assert.ok(issues.some((i) => i.code === "UNKNOWN_TRANSITION"));
  });

  it("rejects unreachable stages", () => {
    const issues = validateWorkflowDocument({
      agent_policy: DEFAULT_AGENT_POLICY,
      stages: [
        { key: "start", name: "Start", transitions: [] },
        { key: "orphan", name: "Orphan", transitions: [] },
      ],
    });
    assert.ok(issues.some((i) => i.code === "UNREACHABLE_STAGE"));
  });

  it("rejects incomplete human gates", () => {
    const issues = validateWorkflowDocument({
      agent_policy: DEFAULT_AGENT_POLICY,
      stages: [
        {
          key: "review",
          name: "Review",
          transitions: ["done"],
          agent: {
            require_human_approval_on_exit: true,
            human_approve_to: "missing",
            human_reject_to: ["also-missing"],
          },
        },
        { key: "done", name: "Done", transitions: [] },
      ],
    });
    assert.ok(issues.some((i) => i.code === "HUMAN_APPROVE_INVALID"));
    assert.ok(issues.some((i) => i.code === "HUMAN_REJECT_INVALID"));
  });
});

describe("canvas roundtrip", () => {
  it("roundtrips stages via edges", () => {
    const stages = DEFAULT_STAGES.slice(0, 3);
    const edges = stagesToEdges(stages);
    const restored = applyEdgesToStages(
      stages.map((s) => ({ ...s, transitions: [] })),
      edges,
    );
    assert.deepEqual(
      restored.map((s) => [s.key, s.transitions]),
      stages.map((s) => [s.key, s.transitions]),
    );
  });

  it("stores edge-scoped rules on the source stage", () => {
    let stage: import("./types.js").WorkflowStage = {
      key: "todo",
      name: "To do",
      transitions: ["in_progress"],
      agent: {},
    };
    stage = setEdgeScopedRules(stage, "in_progress", {
      require_tokens_estimate: true,
      require_playbook_description: true,
    });
    const rules = getEdgeScopedRules(stage, "in_progress");
    assert.equal(rules.require_tokens_estimate, true);
    assert.equal(rules.require_playbook_description, true);
    assert.deepEqual(stage.agent?.require_tokens_estimate_on_exit_to, [
      "in_progress",
    ]);
  });

  it("builds pending draft from canvas without changing live semantics", () => {
    const canvas = documentToCanvas({
      version: 2,
      agent_policy: DEFAULT_AGENT_POLICY,
      stages: DEFAULT_STAGES,
      editor_layout: defaultEditorLayout(DEFAULT_STAGES),
    });
    const pending = canvasToPendingDraft(canvas, { saved_by: "joost" });
    assert.equal(pending.saved_by, "joost");
    assert.equal(pending.stages.length, DEFAULT_STAGES.length);
    assert.ok(pending.editor_layout?.nodes.length);
  });
});

describe("migration + templates", () => {
  it("requires migration map when tickets sit on removed stages", () => {
    const impact = computeMigrationImpact(
      [
        { key: "old", name: "Old", transitions: [] },
        { key: "keep", name: "Keep", transitions: [] },
      ],
      [{ key: "keep", name: "Keep", transitions: [] }],
      [
        {
          slug: "t1",
          ticket_key: "TRA-1",
          title: "One",
          stage: "old",
        },
      ],
    );
    assert.equal(impact.tickets_needing_migration, 1);
    const issues = validateMigrationMap(impact, {}, ["keep"]);
    assert.ok(issues.some((i) => i.code === "MIGRATION_REQUIRED"));
    const ok = validateMigrationMap(impact, { old: "keep" }, ["keep"]);
    assert.equal(ok.length, 0);
  });

  it("refuses silent overwrite unless confirmed", () => {
    const template = {
      slug: "playbook",
      name: "Playbook",
      seed_body: "## Context\n\nx\n",
    };
    assert.throws(() =>
      applyTicketTemplate(
        template,
        { description: "existing body" },
        { mode: "confirm_overwrite", confirmed: false },
      ),
    );
    const filled = applyTicketTemplate(
      template,
      { description: "" },
      { mode: "fill_empty" },
    );
    assert.match(filled.description, /## Context/);
    const merged = applyTicketTemplate(
      template,
      { description: "## Goal\n\nkeep me\n" },
      { mode: "merge_headings" },
    );
    assert.match(merged.description, /## Goal/);
    assert.match(merged.description, /## Context/);
  });
});
