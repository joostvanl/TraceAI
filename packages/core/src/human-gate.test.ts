import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLEARED_REVIEW_FIELDS,
  DEFAULT_STAGES,
  exitRequiresPlaybookDescription,
  exitRequiresTokensEstimate,
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
  });

  it("marks review as human-gated with approve/reject targets", () => {
    const review = DEFAULT_STAGES.find((s) => s.key === "review");
    assert.ok(review);
    assert.equal(review.agent?.require_human_approval_on_exit, true);
    assert.equal(humanApproveTarget(review), "done");
    assert.deepEqual(humanRejectTargets(review), ["todo"]);
  });

  it("gates refinement with target-scoped playbook and estimate flags", () => {
    const refine = DEFAULT_STAGES.find((s) => s.key === "in_refinement");
    assert.ok(refine);
    assert.equal(refine.agent?.require_human_approval_on_exit, true);
    assert.equal(humanApproveTarget(refine), "todo");
    assert.deepEqual(humanRejectTargets(refine), ["backlog"]);
    assert.deepEqual(refine.agent?.require_playbook_description_on_exit_to, [
      "todo",
    ]);
    assert.deepEqual(refine.agent?.require_tokens_estimate_on_exit_to, ["todo"]);
    assert.equal(refine.agent?.require_tokens_estimate_on_exit, undefined);
  });
});

describe("target-scoped exit gates", () => {
  it("requires playbook description only for configured targets", () => {
    const refine = DEFAULT_STAGES.find((s) => s.key === "in_refinement")!;
    assert.equal(exitRequiresPlaybookDescription(refine, "todo"), true);
    assert.equal(exitRequiresPlaybookDescription(refine, "backlog"), false);
  });

  it("requires tokens estimate only for configured targets", () => {
    const refine = DEFAULT_STAGES.find((s) => s.key === "in_refinement")!;
    assert.equal(exitRequiresTokensEstimate(refine, "todo"), true);
    assert.equal(exitRequiresTokensEstimate(refine, "backlog"), false);
  });

  it("works for arbitrarily named stages via workflow JSON alone", () => {
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
            key: "sharpening",
            name: "Sharpening",
            transitions: ["ready", "parked"],
            agent: {
              require_human_approval_on_exit: true,
              human_approve_to: "ready",
              human_reject_to: ["parked"],
              require_playbook_description_on_exit_to: ["ready"],
              require_tokens_estimate_on_exit_to: ["ready"],
            },
          },
          { key: "ready", name: "Ready", transitions: [] },
          { key: "parked", name: "Parked", transitions: [] },
        ],
      }),
    );
    const stage = doc.stages[0]!;
    assert.equal(exitRequiresPlaybookDescription(stage, "ready"), true);
    assert.equal(exitRequiresPlaybookDescription(stage, "parked"), false);
    assert.equal(exitRequiresTokensEstimate(stage, "ready"), true);
    assert.equal(exitRequiresTokensEstimate(stage, "parked"), false);
    assert.equal(
      validateHumanGateExit({
        fromStage: stage,
        toStage: { key: "ready", name: "Ready", transitions: [] },
        comment: "## Vorige stap\nx\n\n## Deze stap\ny",
        asHuman: false,
        reviewState: "approved",
      }).length,
      0,
    );
  });

  it("does not invent agent rules from stage key names", () => {
    const doc = parseWorkflowDocument(
      JSON.stringify({
        version: 2,
        agent_policy: { summary: "t", ticket_description: [], on_every_transition: [] },
        stages: [{ key: "review", name: "Review", transitions: ["done"] }],
      }),
    );
    assert.equal(doc.stages[0]?.agent, undefined);
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
      comment: "## Vorige stap\nx\n\n## Deze stap\ny",
      asHuman: false,
      reviewState: "",
    });
    assert.ok(errors.some((e) => /verdict|approval|review_state/i.test(e)));
  });

  it("lets the agent transition on the back of a verdict", () => {
    assert.deepEqual(
      validateHumanGateExit({
        fromStage: review,
        toStage: done,
        comment: "## Vorige stap\nx\n\n## Deze stap\ny",
        asHuman: false,
        reviewState: "approved",
      }),
      [],
    );
    assert.deepEqual(
      validateHumanGateExit({
        fromStage: review,
        toStage: todo,
        comment: "## Vorige stap\nx\n\n## Deze stap\ny\n\n## Reden\nnope",
        asHuman: false,
        reviewState: "rejected",
      }),
      [],
    );
  });

  it("refuses a target that contradicts the verdict", () => {
    const errors = validateHumanGateExit({
      fromStage: review,
      toStage: todo,
      comment: "## Vorige stap\nx\n\n## Deze stap\ny",
      asHuman: false,
      reviewState: "approved",
    });
    assert.ok(errors.length > 0);
  });

  it("still requires ## Reden when the agent acts on a rejection", () => {
    const errors = validateHumanGateExit({
      fromStage: review,
      toStage: todo,
      comment: "## Vorige stap\nx\n\n## Deze stap\ny",
      asHuman: false,
      reviewState: "rejected",
    });
    assert.ok(errors.some((e) => e.includes("## Reden")));
  });

  it("allows human approve", () => {
    assert.deepEqual(
      validateHumanGateExit({
        fromStage: review,
        toStage: done,
        comment: "## Vorige stap\nx\n\n## Deze stap\ny",
        asHuman: true,
      }),
      [],
    );
  });

  it("requires ## Reden on human reject", () => {
    const errors = validateHumanGateExit({
      fromStage: review,
      toStage: todo,
      comment: "## Vorige stap\nx\n\n## Deze stap\ny",
      asHuman: true,
    });
    assert.ok(errors.some((e) => e.includes("## Reden")));
  });

  it("does nothing when the stage is not gated", () => {
    assert.deepEqual(
      validateHumanGateExit({
        fromStage: todo,
        toStage: inProgress,
        comment: "x",
        asHuman: false,
      }),
      [],
    );
  });
});

describe("review verdicts", () => {
  const review = DEFAULT_STAGES.find((s) => s.key === "review")!;

  it("maps a verdict to the stage the agent must move to", () => {
    assert.equal(reviewVerdictTarget(review, "approved"), "done");
    assert.equal(reviewVerdictTarget(review, "rejected"), "todo");
  });

  it("accepts an approval without a note and a rejection with a reason", () => {
    assert.deepEqual(
      validateReviewVerdict({
        stage: review,
        verdict: "approved",
        comment: "",
      }),
      [],
    );
    assert.deepEqual(
      validateReviewVerdict({
        stage: review,
        verdict: "rejected",
        comment: "Needs more tests",
      }),
      [],
    );
  });

  it("rejects a verdict on an ungated stage, an unknown verdict, or a reasonless rejection", () => {
    const todo = DEFAULT_STAGES.find((s) => s.key === "todo")!;
    assert.ok(
      validateReviewVerdict({
        stage: todo,
        verdict: "approved",
        comment: "",
      }).length,
    );
    assert.ok(
      validateReviewVerdict({
        stage: review,
        verdict: "rejected",
        comment: "",
      }).some((e) => /reden|reason/i.test(e)),
    );
  });

  it("blanks the verdict on a stage change so the next round asks again", () => {
    assert.deepEqual(CLEARED_REVIEW_FIELDS, { review_state: "" });
  });
});
