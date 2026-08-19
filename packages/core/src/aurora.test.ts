import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AURORA_FIELD_IN_MAX,
  AuroraApiError,
  AuroraNetworkError,
  buildEntriesSearchParams,
} from "./aurora.js";

describe("buildEntriesSearchParams", () => {
  it("builds base list params with default locale and limit", () => {
    const params = buildEntriesSearchParams({}, { locale: "en-US" });
    assert.equal(params.get("limit"), "100");
    assert.equal(params.get("locale"), "en-US");
    assert.equal(params.get("field"), null);
    assert.equal(params.get("in"), null);
  });

  it("encodes field filter with a single IN value", () => {
    const params = buildEntriesSearchParams(
      { field: "ticket", in: "my-ticket", limit: 50 },
      { locale: "en-US" },
    );
    assert.equal(params.get("field"), "ticket");
    assert.equal(params.get("in"), "my-ticket");
    assert.equal(params.get("limit"), "50");
  });

  it("joins multiple IN values with commas (max 50)", () => {
    const params = buildEntriesSearchParams(
      { field: "ticket", in: ["a", "b", "c"] },
      { locale: "en-US" },
    );
    assert.equal(params.get("in"), "a,b,c");
  });

  it("rejects empty IN list when field is set", () => {
    assert.throws(
      () =>
        buildEntriesSearchParams(
          { field: "ticket", in: [] },
          { locale: "en-US" },
        ),
      /non-empty/,
    );
  });

  it("rejects IN lists larger than Aurora's max", () => {
    const tooMany = Array.from({ length: AURORA_FIELD_IN_MAX + 1 }, (_, i) =>
      String(i),
    );
    assert.throws(
      () =>
        buildEntriesSearchParams(
          { field: "ticket", in: tooMany },
          { locale: "en-US" },
        ),
      /at most 50/,
    );
  });
});

describe("AuroraNetworkError", () => {
  it("is an AuroraApiError recognized without a magic status 0", () => {
    const err = new AuroraNetworkError("Aurora network error: DNS", {
      cause: new TypeError("fetch failed"),
    });
    assert.equal(err.name, "AuroraNetworkError");
    assert.equal(err.status, 502);
    assert.ok(err instanceof AuroraApiError);
    assert.ok(err.cause instanceof TypeError);
  });
});
