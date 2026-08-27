import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TraceError,
  ValidationError,
  assertNoErrors,
} from "./trace-errors.js";

describe("trace-errors (TRA-79)", () => {
  it("C1: NotFoundError is 404 NOT_FOUND and a TraceError", () => {
    const err = new NotFoundError("Wiki page not found: x");
    assert.equal(err.status, 404);
    assert.equal(err.code, "NOT_FOUND");
    assert.equal(err.message, "Wiki page not found: x");
    assert.ok(err instanceof TraceError);
    assert.ok(err instanceof Error);
  });

  it("C2: ValidationError is 400 VALIDATION", () => {
    const err = new ValidationError("bad", ["x"]);
    assert.equal(err.status, 400);
    assert.equal(err.code, "VALIDATION");
    assert.deepEqual(err.issues, ["x"]);
    assert.ok(err instanceof TraceError);
  });

  it("C3: ForbiddenError is 403 FORBIDDEN", () => {
    const err = new ForbiddenError("User is disabled");
    assert.equal(err.status, 403);
    assert.equal(err.code, "FORBIDDEN");
    assert.ok(err instanceof TraceError);
  });

  it("C3b: ConflictError is 409 (TRA-127 display_name uniqueness)", () => {
    const err = new ConflictError(
      "display_name already used in this project",
      "AGENT_DISPLAY_NAME_CONFLICT",
    );
    assert.equal(err.status, 409);
    assert.equal(err.code, "AGENT_DISPLAY_NAME_CONFLICT");
    assert.ok(err instanceof TraceError);
  });

  it("C4: assertNoErrors([]) does not throw", () => {
    assert.doesNotThrow(() => assertNoErrors([]));
  });

  it("C5: assertNoErrors([\"x\"]) throws ValidationError containing x", () => {
    assert.throws(
      () => assertNoErrors(["x"]),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /x/);
        return true;
      },
    );
  });
});
