import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  StageConflictError,
  enforceExpectedTransition,
} from "./stage-conflict.js";

const mismatch = {
  require: false,
  asHuman: false,
  gatedStage: false,
  expected_stage: "todo",
  reviewStateProvided: false,
  current_stage: "review",
  current_review_state: null as string | null,
  to_stage: "in_progress",
  stage_entered_at: "2026-08-17T19:33:51.374Z",
};

describe("enforceExpectedTransition (service guard)", () => {
  it("S1: mismatch → StageConflictError; write callback never runs", async () => {
    let writes = 0;
    let commentLoads = 0;
    await assert.rejects(
      async () => {
        await enforceExpectedTransition({
          ...mismatch,
          loadComments: async () => {
            commentLoads += 1;
            return [
              {
                author: "Joost",
                createdAt: "2026-08-17T19:33:51.374Z",
                body: "## Vorige stap\nmoved",
              },
            ];
          },
        });
        writes += 1;
      },
      (err: unknown) =>
        err instanceof StageConflictError &&
        err.current_stage === "review" &&
        err.recent_comments.length === 1,
    );
    assert.equal(writes, 0, "addComment/updateEntry must not run after conflict");
    assert.equal(commentLoads, 1);
  });

  it("S2: listing throws → still 409, recent_comments [], no write", async () => {
    let writes = 0;
    await assert.rejects(
      async () => {
        await enforceExpectedTransition({
          ...mismatch,
          loadComments: async () => {
            throw new Error("aurora down");
          },
        });
        writes += 1;
      },
      (err: unknown) =>
        err instanceof StageConflictError &&
        err.recent_comments.length === 0,
    );
    assert.equal(writes, 0);
  });

  it("S3: match (or flag off without fields) → no throw, caller may write", async () => {
    let writes = 0;
    await enforceExpectedTransition({
      require: false,
      asHuman: false,
      gatedStage: false,
      reviewStateProvided: false,
      current_stage: "todo",
      current_review_state: null,
      to_stage: "in_progress",
      stage_entered_at: null,
      loadComments: async () => [],
    });
    writes += 1;
    assert.equal(writes, 1);
  });
});
