import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UNMAPPED_STAGE_KEY } from "@traceai/core";
import { isActiveWorkStage } from "./active-work-stage.js";

describe("isActiveWorkStage", () => {
  it("returns false for a Human Gate column", () => {
    assert.equal(
      isActiveWorkStage({
        stageKey: "backlog",
        requiresHumanApproval: true,
        lastStageKey: "done",
      }),
      false,
    );
  });

  it("returns false for the last live stage", () => {
    assert.equal(
      isActiveWorkStage({
        stageKey: "done",
        requiresHumanApproval: false,
        lastStageKey: "done",
      }),
      false,
    );
  });

  it("returns false for the overflow column", () => {
    assert.equal(
      isActiveWorkStage({
        stageKey: UNMAPPED_STAGE_KEY,
        requiresHumanApproval: false,
        lastStageKey: "done",
      }),
      false,
    );
  });

  it("returns true for other non-gated columns", () => {
    assert.equal(
      isActiveWorkStage({
        stageKey: "todo",
        requiresHumanApproval: false,
        lastStageKey: "done",
      }),
      true,
    );
    assert.equal(
      isActiveWorkStage({
        stageKey: "in_progress",
        requiresHumanApproval: false,
        lastStageKey: "done",
      }),
      true,
    );
    assert.equal(
      isActiveWorkStage({
        stageKey: "review",
        requiresHumanApproval: false,
        lastStageKey: "done",
      }),
      true,
    );
  });

  it("does not treat a missing lastStageKey as Done", () => {
    assert.equal(
      isActiveWorkStage({
        stageKey: "done",
        requiresHumanApproval: false,
      }),
      true,
    );
    assert.equal(
      isActiveWorkStage({
        stageKey: "done",
        requiresHumanApproval: true,
      }),
      false,
    );
    assert.equal(
      isActiveWorkStage({
        stageKey: UNMAPPED_STAGE_KEY,
        requiresHumanApproval: false,
      }),
      false,
    );
  });
});
