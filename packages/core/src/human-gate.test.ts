import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLEARED_REVIEW_FIELDS,
  DEFAULT_STAGES,
  humanApproveTarget,
  humanRejectTargets,
  parseWorkflowDocument,
  reviewVerdictTarget,
  serializeWorkflowDocument,
  validateHumanGateExit,
  validateReviewVerdict,
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
    assert.deepEqual(humanRejectTargets(review), ["todo"]);
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
  const todo = DEFAULT_STAGES.find((s) => s.key === "todo")!;
  const inProgress = DEFAULT_STAGES.find((s) => s.key === "in_progress")!;

  it("blocks agent exit while no verdict was recorded", () => {
    const errors = validateHumanGateExit({
      fromStage: review,
      toStage: done,
      asHuman: false,
      comment:
        "## Vorige stap\nReady\n\n## Deze stap\nApprove\n\n## Wiki\nN/A",
    });
    assert.ok(errors.some((e) => /waiting for a human review verdict/i.test(e)));
  });

  it("lets the agent transition on the back of a verdict", () => {
    const approved = validateHumanGateExit({
      fromStage: review,
      toStage: done,
      asHuman: false,
      reviewState: "approved",
      comment:
        "## Vorige stap\nReady\n\n## Deze stap\nApprove\n\n## Wiki\nN/A",
    });
    assert.deepEqual(approved, []);

    const rejected = validateHumanGateExit({
      fromStage: review,
      toStage: todo,
      asHuman: false,
      reviewState: "rejected",
      comment:
        "## Vorige stap\nReady\n\n## Deze stap\nBack to work\n\n## Reden\nTests failed",
    });
    assert.deepEqual(rejected, []);
  });

  it("refuses a target that contradicts the verdict", () => {
    const errors = validateHumanGateExit({
      fromStage: review,
      toStage: todo,
      asHuman: false,
      reviewState: "approved",
      comment:
        "## Vorige stap\nReady\n\n## Deze stap\nReject\n\n## Reden\nBecause",
    });
    assert.ok(errors.some((e) => /may only move to "done"/i.test(e)));
  });

  it("still requires ## Reden when the agent acts on a rejection", () => {
    const errors = validateHumanGateExit({
      fromStage: review,
      toStage: todo,
      asHuman: false,
      reviewState: "rejected",
      comment: "## Vorige stap\nReady\n\n## Deze stap\nBack to work",
    });
    assert.ok(errors.some((e) => /## Reden/i.test(e)));
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
      toStage: todo,
      asHuman: true,
      comment: "## Vorige stap\nReady\n\n## Deze stap\nReject without reason",
    });
    assert.ok(missing.some((e) => /## Reden/i.test(e)));

    const ok = validateHumanGateExit({
      fromStage: review,
      toStage: todo,
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

describe("review verdicts", () => {
  const review = DEFAULT_STAGES.find((s) => s.key === "review")!;
  const inProgress = DEFAULT_STAGES.find((s) => s.key === "in_progress")!;

  it("maps a verdict to the stage the agent must move to", () => {
    assert.equal(reviewVerdictTarget(review, "approved"), "done");
    assert.equal(reviewVerdictTarget(review, "rejected"), "todo");
    assert.equal(reviewVerdictTarget(inProgress, "approved"), null);
  });

  it("accepts an approval without a note and a rejection with a reason", () => {
    assert.deepEqual(
      validateReviewVerdict({ stage: review, verdict: "approved" }),
      [],
    );
    assert.deepEqual(
      validateReviewVerdict({
        stage: review,
        verdict: "rejected",
        comment: "Tests failed",
      }),
      [],
    );
  });

  it("rejects a verdict on an ungated stage, an unknown verdict, or a reasonless rejection", () => {
    assert.ok(
      validateReviewVerdict({ stage: inProgress, verdict: "approved" }).length,
    );
    assert.ok(validateReviewVerdict({ stage: review, verdict: "maybe" }).length);
    assert.ok(
      validateReviewVerdict({ stage: review, verdict: "rejected" }).some((e) =>
        /reason/i.test(e),
      ),
    );
  });

  it("blanks the verdict on a stage change so the next round asks again", () => {
    assert.equal(CLEARED_REVIEW_FIELDS.review_state, "");
    const errors = validateHumanGateExit({
      fromStage: review,
      toStage: DEFAULT_STAGES.find((s) => s.key === "done")!,
      asHuman: false,
      reviewState: CLEARED_REVIEW_FIELDS.review_state,
      comment: "## Vorige stap\nx\n\n## Deze stap\ny\n\n## Wiki\nN/A",
    });
    assert.ok(errors.some((e) => /waiting for a human review verdict/i.test(e)));
  });
});
