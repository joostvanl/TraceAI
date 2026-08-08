import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_STAGES,
  humanApproveTarget,
  humanRejectTargets,
  parseWorkflowDocument,
  serializeWorkflowDocument,
  validateHumanGateExit,
} from "./types.js";

describe("in_refinement default stages", () => {
  it("places In Refinement between Backlog and To do", () => {
    const keys = DEFAULT_STAGES.map((s) => s.key);
    assert.deepEqual(keys.slice(0, 3), ["backlog", "in_refinement", "todo"]);
    assert.deepEqual(DEFAULT_STAGES[0]?.transitions, ["in_refinement"]);
    assert.ok(DEFAULT_STAGES[1]?.transitions.includes("todo"));
    assert.equal(
      DEFAULT_STAGES[0]?.agent?.require_tokens_estimate_on_exit,
      undefined,
    );
    assert.equal(
      DEFAULT_STAGES[1]?.agent?.require_tokens_estimate_on_exit,
      true,
    );
  });

  it("marks review as human-gated with approve/reject targets", () => {
    const review = DEFAULT_STAGES.find((s) => s.key === "review");
    assert.ok(review);
    assert.equal(review.agent?.require_human_approval_on_exit, true);
    assert.equal(humanApproveTarget(review), "done");
    assert.deepEqual(humanRejectTargets(review), ["in_progress"]);
  });
});

describe("parseStageAgent human gate flags", () => {
  it("preserves require_human_approval_on_exit and targets", () => {
    const doc = parseWorkflowDocument(
      serializeWorkflowDocument({
        version: 2,
        agent_policy: {
          summary: "t",
          ticket_description: [],
          on_every_transition: [],
        },
        stages: [
          {
            key: "review",
            name: "Review",
            transitions: ["done", "in_progress"],
            agent: {
              require_human_approval_on_exit: true,
              human_approve_to: "done",
              human_reject_to: ["in_progress"],
            },
          },
        ],
      }),
    );
    const review = doc.stages[0];
    assert.equal(review?.agent?.require_human_approval_on_exit, true);
    assert.equal(review?.agent?.human_approve_to, "done");
    assert.deepEqual(review?.agent?.human_reject_to, ["in_progress"]);
  });
});

describe("validateHumanGateExit", () => {
  const review = DEFAULT_STAGES.find((s) => s.key === "review")!;
  const done = DEFAULT_STAGES.find((s) => s.key === "done")!;
  const inProgress = DEFAULT_STAGES.find((s) => s.key === "in_progress")!;

  it("blocks agent exit from a gated stage", () => {
    const errors = validateHumanGateExit({
      fromStage: review,
      toStage: done,
      asHuman: false,
      comment:
        "## Vorige stap\nReady\n\n## Deze stap\nApprove\n\n## Wiki\nN/A",
    });
    assert.ok(errors.some((e) => /human approval/i.test(e)));
  });

  it("allows human approve", () => {
    const errors = validateHumanGateExit({
      fromStage: review,
      toStage: done,
      asHuman: true,
      comment:
        "## Vorige stap\nReady\n\n## Deze stap\nApprove\n\n## Wiki\nN/A",
    });
    assert.deepEqual(errors, []);
  });

  it("requires ## Reden on human reject", () => {
    const missing = validateHumanGateExit({
      fromStage: review,
      toStage: inProgress,
      asHuman: true,
      comment: "## Vorige stap\nReady\n\n## Deze stap\nReject without reason",
    });
    assert.ok(missing.some((e) => /## Reden/i.test(e)));

    const ok = validateHumanGateExit({
      fromStage: review,
      toStage: inProgress,
      asHuman: true,
      comment:
        "## Vorige stap\nReady\n\n## Deze stap\nReject\n\n## Reden\nTests failed",
    });
    assert.deepEqual(ok, []);
  });

  it("does nothing when the stage is not gated", () => {
    const errors = validateHumanGateExit({
      fromStage: inProgress,
      toStage: review,
      asHuman: false,
      comment: "## Vorige stap\nx\n\n## Deze stap\ny",
    });
    assert.deepEqual(errors, []);
  });
});
