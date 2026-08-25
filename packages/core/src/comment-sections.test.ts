import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_AGENT_POLICY,
  DEFAULT_STAGES,
  formatReviewVerdictComment,
  parseWorkflowDocument,
  serializeWorkflowDocument,
  validateHumanGateExit,
  validateTransitionComment,
  type WorkflowAgentPolicy,
  type WorkflowStage,
} from "./types.js";

const shortComment =
  "Implemented the parser change and the generic heading matcher.";

const emptyPolicy: WorkflowAgentPolicy = {
  summary: "x",
  ticket_description: [],
  on_every_transition: ["comment"],
};

describe("generic comment heading gates", () => {
  it("parses require_comment_sections without defaulting product headings", () => {
    const omitted = parseWorkflowDocument(
      JSON.stringify({
        version: 2,
        agent_policy: { summary: "x" },
        stages: [],
      }),
    );
    assert.equal(omitted.agent_policy.require_comment_sections, undefined);
    assert.equal(DEFAULT_AGENT_POLICY.require_comment_sections, undefined);

    const listed = parseWorkflowDocument(
      JSON.stringify({
        version: 2,
        agent_policy: {
          summary: "x",
          require_comment_sections: ["## Deze stap"],
        },
        stages: [],
      }),
    );
    assert.deepEqual(listed.agent_policy.require_comment_sections, [
      "## Deze stap",
    ]);
  });

  it("parses reject/dismiss section lists from workflow JSON", () => {
    const doc = parseWorkflowDocument(
      serializeWorkflowDocument({
        version: 2,
        agent_policy: emptyPolicy,
        stages: [
          {
            key: "gate",
            name: "Gate",
            transitions: ["ok", "no"],
            agent: {
              require_comment_sections_on_reject: ["## Why"],
              require_comment_sections_on_dismiss: ["## Stop"],
            },
          },
        ],
      }),
    );
    assert.deepEqual(doc.stages[0]?.agent?.require_comment_sections_on_reject, [
      "## Why",
    ]);
    assert.deepEqual(doc.stages[0]?.agent?.require_comment_sections_on_dismiss, [
      "## Stop",
    ]);
  });

  it("accepts a heading-free comment when JSON lists none", () => {
    const from: WorkflowStage = {
      key: "todo",
      name: "To do",
      transitions: ["in_progress"],
      agent: { require_comment_on_exit: true },
    };
    const to: WorkflowStage = {
      key: "in_progress",
      name: "In progress",
      transitions: [],
    };
    const errors = validateTransitionComment({
      fromStage: from,
      toStage: to,
      policy: emptyPolicy,
      comment: shortComment,
    });
    assert.deepEqual(errors, []);
    assert.equal(/##/.test(shortComment), false);
    assert.ok(shortComment.length >= 40);
  });

  it("fails when policy.require_comment_sections lists ## Deze stap", () => {
    const from: WorkflowStage = {
      key: "todo",
      name: "To do",
      transitions: ["in_progress"],
    };
    const to: WorkflowStage = {
      key: "in_progress",
      name: "In progress",
      transitions: [],
    };
    const errors = validateTransitionComment({
      fromStage: from,
      toStage: to,
      policy: {
        ...emptyPolicy,
        require_comment_sections: ["## Deze stap"],
      },
      comment: shortComment,
    });
    assert.ok(errors.some((e) => e.includes("## Deze stap")));
    const ok = validateTransitionComment({
      fromStage: from,
      toStage: to,
      policy: {
        ...emptyPolicy,
        require_comment_sections: ["## Deze stap"],
      },
      comment: `${shortComment}\n\n## Deze stap\nShipped the matcher.`,
    });
    assert.deepEqual(ok, []);
  });

  it("still requires Testverslag when the destination stage JSON says so", () => {
    const review = DEFAULT_STAGES.find((s) => s.key === "review")!;
    const inProgress = DEFAULT_STAGES.find((s) => s.key === "in_progress")!;
    const missing = validateTransitionComment({
      fromStage: inProgress,
      toStage: review,
      policy: emptyPolicy,
      comment: shortComment,
    });
    assert.ok(missing.some((e) => e.includes("## Testverslag")));
    const ok = validateTransitionComment({
      fromStage: inProgress,
      toStage: review,
      policy: emptyPolicy,
      comment: `${shortComment}\n\n## Testverslag\n- unit — PASS\n\n## Uitslag\nPASS`,
    });
    assert.ok(!ok.some((e) => e.includes("## Testverslag")));
  });

  it("requires ## Reden on reject only when the stage lists it", () => {
    const review = DEFAULT_STAGES.find((s) => s.key === "review")!;
    const todo = DEFAULT_STAGES.find((s) => s.key === "todo")!;
    assert.deepEqual(review.agent?.require_comment_sections_on_reject, [
      "## Reden",
    ]);
    const missing = validateHumanGateExit({
      fromStage: review,
      toStage: todo,
      comment: shortComment,
      asHuman: true,
    });
    assert.ok(missing.some((e) => e.includes("## Reden")));

    const custom: WorkflowStage = {
      key: "gate",
      name: "Gate",
      transitions: ["back"],
      agent: {
        require_human_approval_on_exit: true,
        human_reject_to: ["back"],
      },
    };
    const none = validateHumanGateExit({
      fromStage: custom,
      toStage: { key: "back", name: "Back", transitions: [] },
      comment: shortComment,
      asHuman: true,
    });
    assert.ok(!none.some((e) => e.includes("## Reden")));
    assert.deepEqual(none, []);
  });

  it("formatReviewVerdictComment has no Vorige stap / Ticket stond in boilerplate", () => {
    const review = DEFAULT_STAGES.find((s) => s.key === "review")!;
    const approved = formatReviewVerdictComment({
      stage: review,
      verdict: "approved",
      author: "joostvl",
      target: "done",
      comment: "Looks good",
    });
    assert.equal(approved.includes("## Vorige stap"), false);
    assert.equal(approved.includes("Ticket stond in"), false);
    assert.match(approved, /Goedgekeurd door joostvl/);
    assert.match(approved, /Looks good/);
    assert.equal(approved.includes("## Toelichting"), false);

    const rejected = formatReviewVerdictComment({
      stage: review,
      verdict: "rejected",
      author: "joostvl",
      target: "todo",
      comment: "Needs tests",
    });
    assert.equal(rejected.includes("## Vorige stap"), false);
    assert.equal(rejected.includes("Ticket stond in"), false);
    assert.match(rejected, /## Reden\nNeeds tests/);
  });
});
