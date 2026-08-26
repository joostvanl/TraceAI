import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_STAGES,
  parseWorkflowDocument,
  serializeWorkflowDocument,
} from "./types.js";
import {
  HUMAN_GATE_OPEN,
  HumanGateOpenError,
  assertHumanGateTransition,
  skippedHumanGatedStages,
} from "./human-gate-open.js";

function storyStages() {
  return parseWorkflowDocument(
    serializeWorkflowDocument({
      version: 3,
      agent_policy: {
        summary: "t",
        ticket_description: [],
        on_every_transition: [],
      },
      stages: DEFAULT_STAGES,
    }),
  ).stages;
}

function shortcutWorkflow() {
  return parseWorkflowDocument(
    serializeWorkflowDocument({
      version: 3,
      agent_policy: {
        summary: "t",
        ticket_description: [],
        on_every_transition: [],
      },
      stages: [
        { key: "todo", name: "To do", transitions: ["in_progress"] },
        {
          key: "in_progress",
          name: "In progress",
          transitions: ["review", "done", "todo"],
        },
        {
          key: "review",
          name: "Review",
          transitions: ["uat_review", "in_progress"],
        },
        {
          key: "uat_review",
          name: "UAT",
          transitions: ["done", "in_progress"],
          agent: {
            require_human_approval_on_exit: true,
            human_approve_to: "done",
            human_reject_to: ["in_progress"],
          },
        },
        { key: "done", name: "Done", transitions: ["todo"] },
      ],
    }),
  ).stages;
}

describe("skippedHumanGatedStages", () => {
  it("finds a chord that jumps past a later gated stage", () => {
    const stages = shortcutWorkflow();
    assert.deepEqual(
      skippedHumanGatedStages(stages, "in_progress", "done"),
      ["uat_review"],
    );
  });

  it("does not treat a backward edge as a skip", () => {
    const stages = shortcutWorkflow();
    assert.deepEqual(skippedHumanGatedStages(stages, "in_progress", "todo"), []);
  });

  it("does not flag adjacent hops", () => {
    const stages = shortcutWorkflow();
    assert.deepEqual(
      skippedHumanGatedStages(stages, "in_progress", "review"),
      [],
    );
  });
});

describe("assertHumanGateTransition", () => {
  const stages = storyStages();
  const todo = stages.find((s) => s.key === "todo")!;
  const inProgress = stages.find((s) => s.key === "in_progress")!;
  const review = stages.find((s) => s.key === "review")!;
  const done = stages.find((s) => s.key === "done")!;

  it("throws 409 HUMAN_GATE_OPEN when To do has no verdict", () => {
    assert.throws(
      () =>
        assertHumanGateTransition({
          stages,
          fromStage: todo,
          toStage: inProgress,
          reviewState: null,
        }),
      (err: unknown) => {
        assert.ok(err instanceof HumanGateOpenError);
        assert.equal(err.status, 409);
        assert.equal(err.code, HUMAN_GATE_OPEN);
        assert.equal(err.current_stage, "todo");
        assert.equal(err.review_state, null);
        assert.equal(err.to_stage, "in_progress");
        assert.ok(err.allowed_targets.includes("in_progress"));
        assert.match(err.message, /Goedkeuren\/Afkeuren\/Annuleren/);
        assert.equal(/Afzien/.test(err.message), false);
        return true;
      },
    );
  });

  it("throws 409 when Review/UAT has no verdict toward Done", () => {
    assert.throws(
      () =>
        assertHumanGateTransition({
          stages,
          fromStage: review,
          toStage: done,
          reviewState: "",
        }),
      (err: unknown) => {
        assert.ok(err instanceof HumanGateOpenError);
        assert.equal(err.current_stage, "review");
        assert.ok(err.allowed_targets.includes("done"));
        return true;
      },
    );
  });

  it("allows the matching approve target after a verdict", () => {
    assert.doesNotThrow(() =>
      assertHumanGateTransition({
        stages,
        fromStage: todo,
        toStage: inProgress,
        reviewState: "approved",
      }),
    );
  });

  it("throws 409 when the target contradicts the verdict", () => {
    assert.throws(
      () =>
        assertHumanGateTransition({
          stages,
          fromStage: todo,
          toStage: done,
          reviewState: "approved",
        }),
      HumanGateOpenError,
    );
  });

  it("lets asHuman skip the 409 (board UI)", () => {
    assert.doesNotThrow(() =>
      assertHumanGateTransition({
        stages,
        fromStage: todo,
        toStage: inProgress,
        asHuman: true,
        reviewState: null,
      }),
    );
  });

  it("throws 409 when a non-gated stage skips a later gate", () => {
    const shortcut = shortcutWorkflow();
    const from = shortcut.find((s) => s.key === "in_progress")!;
    const to = shortcut.find((s) => s.key === "done")!;
    assert.throws(
      () =>
        assertHumanGateTransition({
          stages: shortcut,
          fromStage: from,
          toStage: to,
        }),
      (err: unknown) => {
        assert.ok(err instanceof HumanGateOpenError);
        assert.match(err.message, /uat_review/);
        return true;
      },
    );
  });
});
