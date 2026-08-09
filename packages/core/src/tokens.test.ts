import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AGENT_POLICY,
  DEFAULT_STAGES,
  parseWorkflowDocument,
  validateTransitionTokens,
  type WorkflowAgentPolicy,
  type WorkflowStage,
} from "./types.js";

const backlog = DEFAULT_STAGES.find((s) => s.key === "backlog")!;
const inRefinement = DEFAULT_STAGES.find((s) => s.key === "in_refinement")!;
const todo = DEFAULT_STAGES.find((s) => s.key === "todo")!;
const inProgress = DEFAULT_STAGES.find((s) => s.key === "in_progress")!;

describe("validateTransitionTokens", () => {
  it("requires tokens_estimate when leaving a stage with the flag", () => {
    const errors = validateTransitionTokens({
      fromStage: inRefinement,
      toStage: todo,
      policy: { ...DEFAULT_AGENT_POLICY, require_tokens_used_on_transition: false },
      tokens_used: 100,
    });
    assert.ok(errors.some((e) => e.includes("tokens_estimate")));
  });

  it("accepts a valid estimate when leaving a flagged stage", () => {
    const errors = validateTransitionTokens({
      fromStage: inRefinement,
      toStage: todo,
      policy: { ...DEFAULT_AGENT_POLICY, require_tokens_used_on_transition: false },
      tokens_estimate: 12000,
      tokens_used: 0,
    });
    assert.deepEqual(errors, []);
  });

  it("does not require estimate when the stage flag is off", () => {
    const plain: WorkflowStage = {
      key: "backlog",
      name: "Backlog",
      transitions: ["in_refinement"],
      agent: { require_tokens_estimate_on_exit: false },
    };
    const errors = validateTransitionTokens({
      fromStage: plain,
      toStage: inRefinement,
      policy: { summary: "", ticket_description: [], on_every_transition: [] },
    });
    assert.deepEqual(errors, []);
  });

  it("requires tokens_used when the policy flag is on", () => {
    const errors = validateTransitionTokens({
      fromStage: todo,
      toStage: inProgress,
      policy: { ...DEFAULT_AGENT_POLICY, require_tokens_used_on_transition: true },
    });
    assert.ok(errors.some((e) => e.includes("tokens_used")));
  });

  it("rejects negative or non-integer token counts", () => {
    const errors = validateTransitionTokens({
      fromStage: inRefinement,
      toStage: todo,
      policy: DEFAULT_AGENT_POLICY,
      tokens_estimate: 12.5,
      tokens_used: -1,
    });
    assert.ok(errors.some((e) => e.includes("tokens_estimate")));
    assert.ok(errors.some((e) => e.includes("tokens_used")));
  });

  it("does not require estimate when leaving a gated stage towards a reject target", () => {
    const errors = validateTransitionTokens({
      fromStage: inRefinement,
      toStage: backlog,
      policy: { ...DEFAULT_AGENT_POLICY, require_tokens_used_on_transition: false },
      tokens_used: 50,
    });
    assert.deepEqual(errors, []);
  });

  it("honours require_tokens_estimate_on_exit_to over the legacy boolean", () => {
    const stage: WorkflowStage = {
      key: "sharpening",
      name: "Sharpening",
      transitions: ["ready", "parked"],
      agent: {
        require_tokens_estimate_on_exit: true,
        require_tokens_estimate_on_exit_to: ["ready"],
      },
    };
    const ready: WorkflowStage = { key: "ready", name: "Ready", transitions: [] };
    const parked: WorkflowStage = { key: "parked", name: "Parked", transitions: [] };
    const policy = {
      ...DEFAULT_AGENT_POLICY,
      require_tokens_used_on_transition: false,
    };
    assert.ok(
      validateTransitionTokens({
        fromStage: stage,
        toStage: ready,
        policy,
      }).some((e) => e.includes("tokens_estimate")),
    );
    assert.deepEqual(
      validateTransitionTokens({
        fromStage: stage,
        toStage: parked,
        policy,
        tokens_used: 1,
      }),
      [],
    );
  });

  it("does not hard-code stage names — only flags matter", () => {
    const intake: WorkflowStage = {
      key: "ideas",
      name: "Ideas",
      transitions: ["ready"],
      agent: { require_tokens_estimate_on_exit: true },
    };
    const ready: WorkflowStage = {
      key: "ready",
      name: "Ready",
      transitions: [],
    };
    const policy: WorkflowAgentPolicy = {
      summary: "",
      ticket_description: [],
      on_every_transition: [],
      require_tokens_used_on_transition: true,
    };
    const missing = validateTransitionTokens({
      fromStage: intake,
      toStage: ready,
      policy,
    });
    assert.ok(missing.some((e) => e.includes("tokens_estimate")));
    assert.ok(missing.some((e) => e.includes("tokens_used")));

    const ok = validateTransitionTokens({
      fromStage: intake,
      toStage: ready,
      policy,
      tokens_estimate: 5000,
      tokens_used: 200,
    });
    assert.deepEqual(ok, []);
  });
});

describe("workflow token flags parsing", () => {
  it("parses require_tokens flags without inventing them when absent", () => {
    const doc = parseWorkflowDocument(
      JSON.stringify({
        version: 2,
        agent_policy: {
          summary: "x",
          ticket_description: [],
          on_every_transition: [],
        },
        stages: [
          {
            key: "backlog",
            name: "Backlog",
            transitions: ["in_refinement"],
            agent: { purpose: "parked" },
          },
          { key: "todo", name: "To do", transitions: [] },
        ],
      }),
    );
    assert.equal(doc.agent_policy.require_tokens_used_on_transition, undefined);
    assert.equal(
      doc.stages[0]?.agent?.require_tokens_estimate_on_exit,
      undefined,
    );
  });

  it("defaults enable token tracking on the product workflow template", () => {
    assert.equal(DEFAULT_AGENT_POLICY.require_tokens_used_on_transition, true);
    assert.equal(backlog.agent?.require_tokens_estimate_on_exit, undefined);
    assert.deepEqual(inRefinement.agent?.require_tokens_estimate_on_exit_to, [
      "todo",
    ]);
  });
});