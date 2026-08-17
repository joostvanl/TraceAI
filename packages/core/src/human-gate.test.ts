import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLEARED_REVIEW_FIELDS,
  DEFAULT_STAGES,
  exitRequiresPlaybookDescription,
  exitRequiresTokensEstimate,
  humanApproveTarget,
  humanDismissTarget,
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

  it("marks review as human-gated with approve/reject and no dismiss", () => {
    const review = DEFAULT_STAGES.find((s) => s.key === "review");
    assert.ok(review);
    assert.equal(review.agent?.require_human_approval_on_exit, true);
    assert.equal(humanApproveTarget(review), "done");
    assert.deepEqual(humanRejectTargets(review), ["todo"]);
    assert.equal(humanDismissTarget(review), null);
  });

  it("gates refinement with dismiss and todo as approve+dismiss intake", () => {
    const refine = DEFAULT_STAGES.find((s) => s.key === "in_refinement");
    assert.ok(refine);
    assert.equal(refine.agent?.require_human_approval_on_exit, true);
    assert.equal(humanApproveTarget(refine), "todo");
    assert.deepEqual(humanRejectTargets(refine), ["backlog"]);
    assert.equal(humanDismissTarget(refine), "done");
    assert.deepEqual(refine.agent?.require_playbook_description_on_exit_to, [
      "todo",
    ]);
    assert.deepEqual(refine.agent?.require_tokens_estimate_on_exit_to, ["todo"]);

    const todo = DEFAULT_STAGES.find((s) => s.key === "todo");
    assert.ok(todo);
    assert.equal(todo.agent?.require_human_approval_on_exit, true);
    assert.equal(humanApproveTarget(todo), "in_progress");
    assert.deepEqual(humanRejectTargets(todo), []);
    assert.equal(humanDismissTarget(todo), "done");
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
            transitions: ["ready", "parked", "closed"],
            agent: {
              require_human_approval_on_exit: true,
              human_approve_to: "ready",
              human_reject_to: ["parked"],
              human_dismiss_to: "closed",
              require_playbook_description_on_exit_to: ["ready"],
              require_tokens_estimate_on_exit_to: ["ready"],
            },
          },
          { key: "ready", name: "Ready", transitions: [] },
          { key: "parked", name: "Parked", transitions: [] },
          { key: "closed", name: "Closed", transitions: [] },
        ],
      }),
    );
    const stage = doc.stages[0]!;
    assert.equal(exitRequiresPlaybookDescription(stage, "ready"), true);
    assert.equal(exitRequiresPlaybookDescription(stage, "parked"), false);
    assert.equal(humanDismissTarget(stage), "closed");
    assert.equal(reviewVerdictTarget(stage, "dismissed"), "closed");
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
    assert.equal(
      validateHumanGateExit({
        fromStage: stage,
        toStage: { key: "closed", name: "Closed", transitions: [] },
        comment: "## Vorige stap\nx\n\n## Deze stap\ny\n\n## Reden\nabandon",
        asHuman: false,
        reviewState: "dismissed",
      }).length,
      0,
    );
  });

  it("supports approve+dismiss gates with no reject outcome", () => {
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
            key: "intake",
            name: "Intake",
            transitions: ["build", "drop"],
            agent: {
              require_human_approval_on_exit: true,
              human_approve_to: "build",
              human_reject_to: [],
              human_dismiss_to: "drop",
            },
          },
          { key: "build", name: "Build", transitions: [] },
          { key: "drop", name: "Drop", transitions: [] },
        ],
      }),
    );
    const stage = doc.stages[0]!;
    assert.deepEqual(humanRejectTargets(stage), []);
    assert.equal(humanDismissTarget(stage), "drop");
    assert.equal(reviewVerdictTarget(stage, "rejected"), null);
    assert.ok(
      validateReviewVerdict({
        stage,
        verdict: "rejected",
        comment: "nope",
      }).some((e) => /no reject target/i.test(e)),
    );
    assert.deepEqual(
      validateReviewVerdict({
        stage,
        verdict: "dismissed",
        comment: "not now",
      }),
      [],
    );
  });

  it("does not invent agent rules from stage key names", () => {
    const doc = parseWorkflowDocument(
      JSON.stringify({
        version: 2,
        agent_policy: {
          summary: "t",
          ticket_description: [],
          on_every_transition: [],
        },
        stages: [{ key: "review", name: "Review", transitions: ["done"] }],
      }),
    );
    assert.equal(doc.stages[0]?.agent, undefined);
  });
});

describe("parseStageAgent human gate flags", () => {
  it("preserves require_human_approval_on_exit and targets including dismiss", () => {
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
            transitions: ["done", "in_progress", "closed"],
            agent: {
              require_human_approval_on_exit: true,
              human_approve_to: "done",
              human_reject_to: ["in_progress"],
              human_dismiss_to: "closed",
            },
          },
        ],
      }),
    );
    const review = doc.stages[0];
    assert.equal(review?.agent?.require_human_approval_on_exit, true);
    assert.equal(review?.agent?.human_approve_to, "done");
    assert.deepEqual(review?.agent?.human_reject_to, ["in_progress"]);
    assert.equal(review?.agent?.human_dismiss_to, "closed");
  });
});

describe("validateHumanGateExit", () => {
  const review = DEFAULT_STAGES.find((s) => s.key === "review")!;
  const done = DEFAULT_STAGES.find((s) => s.key === "done")!;
  const todo = DEFAULT_STAGES.find((s) => s.key === "todo")!;
  const inProgress = DEFAULT_STAGES.find((s) => s.key === "in_progress")!;
  const backlog = DEFAULT_STAGES.find((s) => s.key === "backlog")!;
  const refine = DEFAULT_STAGES.find((s) => s.key === "in_refinement")!;

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

  it("lets the agent dismiss toward human_dismiss_to with ## Reden", () => {
    assert.deepEqual(
      validateHumanGateExit({
        fromStage: refine,
        toStage: done,
        comment: "## Vorige stap\nx\n\n## Deze stap\ny\n\n## Reden\nstop",
        asHuman: false,
        reviewState: "dismissed",
      }),
      [],
    );
    const missingReason = validateHumanGateExit({
      fromStage: refine,
      toStage: done,
      comment: "## Vorige stap\nx\n\n## Deze stap\ny",
      asHuman: false,
      reviewState: "dismissed",
    });
    assert.ok(missingReason.some((e) => e.includes("## Reden")));
  });

  it("refuses dismiss when the stage has no dismiss target", () => {
    assert.ok(
      validateReviewVerdict({
        stage: review,
        verdict: "dismissed",
        comment: "stop",
      }).some((e) => /no dismiss target/i.test(e)),
    );
    const errors = validateHumanGateExit({
      fromStage: review,
      toStage: done,
      comment: "## Vorige stap\nx\n\n## Deze stap\ny\n\n## Reden\nstop",
      asHuman: false,
      reviewState: "dismissed",
    });
    assert.ok(errors.length > 0);
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
        fromStage: backlog,
        toStage: refine,
        comment: "x",
        asHuman: false,
      }),
      [],
    );
    assert.deepEqual(
      validateHumanGateExit({
        fromStage: inProgress,
        toStage: review,
        comment: "x",
        asHuman: false,
      }),
      [],
    );
  });
});

describe("review verdicts", () => {
  const review = DEFAULT_STAGES.find((s) => s.key === "review")!;
  const refine = DEFAULT_STAGES.find((s) => s.key === "in_refinement")!;

  it("maps a verdict to the stage the agent must move to", () => {
    assert.equal(reviewVerdictTarget(review, "approved"), "done");
    assert.equal(reviewVerdictTarget(review, "rejected"), "todo");
    assert.equal(reviewVerdictTarget(review, "dismissed"), null);
    assert.equal(reviewVerdictTarget(refine, "dismissed"), "done");
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

  it("rejects unknown verdicts, reasonless reject/dismiss, and ungated stages", () => {
    assert.ok(
      validateReviewVerdict({
        stage: review,
        verdict: "maybe",
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
    assert.ok(
      validateReviewVerdict({
        stage: refine,
        verdict: "dismissed",
        comment: "",
      }).some((e) => /reason/i.test(e)),
    );
    assert.ok(
      validateReviewVerdict({
        stage: DEFAULT_STAGES.find((s) => s.key === "in_progress")!,
        verdict: "approved",
        comment: "",
      }).length,
    );
  });

  it("blanks the verdict on a stage change so the next round asks again", () => {
    assert.deepEqual(CLEARED_REVIEW_FIELDS, { review_state: "" });
  });
});
