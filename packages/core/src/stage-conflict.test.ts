import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMMENT_BODY_MAX,
  ExpectedStateRequiredError,
  MISSING_EXPECTED_REVIEW_STATE,
  MISSING_EXPECTED_STAGE,
  StageConflictError,
  assertExpectedState,
  missingExpectedStateErrors,
  throwIfMissingExpectedState,
  truncateCommentBody,
} from "./stage-conflict.js";

const base = {
  current_stage: "todo",
  current_review_state: null as string | null,
  to_stage: "in_progress",
  reviewStateProvided: false,
};

describe("missingExpectedStateErrors", () => {
  it("C1/C7: flag off, fields omitted → no errors", () => {
    assert.deepEqual(
      missingExpectedStateErrors({
        require: false,
        asHuman: false,
        gatedStage: false,
        reviewStateProvided: false,
      }),
      [],
    );
  });

  it("C8: flag on, agent, expected_stage omitted → MISSING_EXPECTED_STAGE", () => {
    const errors = missingExpectedStateErrors({
      require: true,
      asHuman: false,
      gatedStage: false,
      reviewStateProvided: false,
    });
    assert.deepEqual(errors, [MISSING_EXPECTED_STAGE]);
  });

  it("C12: C8 text is exactly the constant (no 'not allowed')", () => {
    const errors = missingExpectedStateErrors({
      require: true,
      asHuman: false,
      gatedStage: false,
      reviewStateProvided: false,
    });
    assert.equal(errors[0], MISSING_EXPECTED_STAGE);
    assert.equal(/not allowed|forbidden|not found/i.test(errors[0]!), false);
  });

  it("C9: flag on, asHuman, fields omitted → no errors", () => {
    assert.deepEqual(
      missingExpectedStateErrors({
        require: true,
        asHuman: true,
        gatedStage: true,
        reviewStateProvided: false,
      }),
      [],
    );
  });

  it("C10: flag on, non-gated, stage set, review omitted → no errors", () => {
    assert.deepEqual(
      missingExpectedStateErrors({
        require: true,
        asHuman: false,
        gatedStage: false,
        expected_stage: "todo",
        reviewStateProvided: false,
      }),
      [],
    );
  });

  it("C10b: flag on, gated, stage set, review omitted → MISSING_EXPECTED_REVIEW_STATE", () => {
    const errors = missingExpectedStateErrors({
      require: true,
      asHuman: false,
      gatedStage: true,
      expected_stage: "review",
      reviewStateProvided: false,
    });
    assert.deepEqual(errors, [MISSING_EXPECTED_REVIEW_STATE]);
  });

  it("empty expected_stage counts as omitted", () => {
    const errors = missingExpectedStateErrors({
      require: true,
      asHuman: false,
      gatedStage: false,
      expected_stage: "",
      reviewStateProvided: false,
    });
    assert.deepEqual(errors, [MISSING_EXPECTED_STAGE]);
  });

  it("throwIfMissingExpectedState throws ExpectedStateRequiredError", () => {
    assert.throws(
      () =>
        throwIfMissingExpectedState({
          require: true,
          asHuman: false,
          gatedStage: false,
          reviewStateProvided: false,
        }),
      (err: unknown) =>
        err instanceof ExpectedStateRequiredError &&
        err.status === 400 &&
        err.code === "VALIDATION" &&
        err.message === MISSING_EXPECTED_STAGE,
    );
  });
});

describe("assertExpectedState", () => {
  it("C1: expected_stage undefined, review not set → no throw", () => {
    assertExpectedState({ ...base });
  });

  it("C2: expected_stage empty → no stage throw", () => {
    assertExpectedState({ ...base, expected_stage: "" });
  });

  it("C3: stage + review_state match (null/null)", () => {
    assertExpectedState({
      ...base,
      expected_stage: "todo",
      reviewStateProvided: true,
      expected_review_state: null,
      current_review_state: null,
    });
  });

  it("C4: stage mismatch → StageConflictError with both stages", () => {
    try {
      assertExpectedState({
        ...base,
        expected_stage: "todo",
        current_stage: "review",
        to_stage: "in_progress",
        recent_comments: [
          {
            author: "Joost",
            createdAt: "2026-08-17T19:33:51.374Z",
            body: "moved",
            truncated: false,
          },
        ],
      });
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof StageConflictError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "STAGE_CONFLICT");
      assert.match(err.message, /review/);
      assert.match(err.message, /todo/);
      assert.equal(err.current_stage, "review");
      assert.equal(err.expected_stage, "todo");
      assert.equal(err.to_stage, "in_progress");
      assert.equal(err.recent_comments.length, 1);
    }
  });

  it("C5: review_state mismatch, stage equal", () => {
    try {
      assertExpectedState({
        expected_stage: "review",
        current_stage: "review",
        reviewStateProvided: true,
        expected_review_state: "approved",
        current_review_state: "rejected",
        to_stage: "done",
      });
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof StageConflictError);
      assert.match(err.message, /review_state/);
      assert.match(err.message, /approved/);
      assert.match(err.message, /rejected/);
      assert.equal(err.review_state, "rejected");
      assert.equal(err.expected_review_state, "approved");
    }
  });

  it("C6: both mismatch → message contains both", () => {
    try {
      assertExpectedState({
        expected_stage: "todo",
        current_stage: "review",
        reviewStateProvided: true,
        expected_review_state: "approved",
        current_review_state: "rejected",
        to_stage: "done",
      });
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof StageConflictError);
      assert.match(err.message, /todo/);
      assert.match(err.message, /review/);
      assert.match(err.message, /approved/);
      assert.match(err.message, /rejected/);
    }
  });

  it("empty review_state matches null", () => {
    assertExpectedState({
      expected_stage: "todo",
      current_stage: "todo",
      reviewStateProvided: true,
      expected_review_state: null,
      current_review_state: "",
      to_stage: "in_progress",
    });
  });
});

describe("truncateCommentBody", () => {
  it("C11: short body is not truncated", () => {
    const result = truncateCommentBody("hello");
    assert.deepEqual(result, { body: "hello", truncated: false });
  });

  it("C11: long body gets suffix ... and truncated true", () => {
    const long = "x".repeat(COMMENT_BODY_MAX + 10);
    const result = truncateCommentBody(long);
    assert.equal(result.truncated, true);
    assert.ok(result.body.endsWith("..."));
    assert.equal(result.body.length, COMMENT_BODY_MAX + 3);
  });
});
