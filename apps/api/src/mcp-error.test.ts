import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraceApiError } from "@traceai/core";
import { formatToolError } from "@traceai/mcp";

describe("formatToolError (TRA-73 / TRA-70)", () => {
  it("M1: STAGE_CONFLICT dumps body and has no wiki-anchor hint", () => {
    const body = {
      message: 'Ticket is in "review", not the expected "todo". Another actor moved it.',
      code: "STAGE_CONFLICT",
      current_stage: "review",
      recent_comments: [{ author: "Joost", body: "moved", truncated: false }],
    };
    const text = formatToolError(
      new TraceApiError(body.message, 409, "STAGE_CONFLICT", body),
    );
    assert.match(text, /Error 409 STAGE_CONFLICT/);
    assert.match(text, /current_stage/);
    assert.match(text, /recent_comments/);
    assert.match(text, /another actor moved this ticket/i);
    assert.equal(/get_wiki_page/.test(text), false);
    assert.equal(/anchor/.test(text), false);
  });

  it("M2: wiki CONFLICT keeps the TRA-70 hint and does not dump STAGE_CONFLICT body", () => {
    const text = formatToolError(
      new TraceApiError("old_string not found", 409, "CONFLICT", {
        code: "CONFLICT",
        issues: [{ code: "not_found" }],
      }),
    );
    assert.match(text, /get_wiki_page/);
    assert.equal(/STAGE_CONFLICT/.test(text), false);
    assert.equal(/recent_comments/.test(text), false);
  });

  it("M3: 502 BAD_GATEWAY hints Aurora/upstream and has no INVALID_400 hint", () => {
    const text = formatToolError(
      new TraceApiError("Aurora API 503", 502, "BAD_GATEWAY"),
    );
    assert.match(text, /Error 502 BAD_GATEWAY/);
    assert.match(text, /Aurora\/upstream/i);
    assert.equal(/resending it unchanged will fail again/i.test(text), false);
  });

  it("M4: 500 INTERNAL hints server fault and has no INVALID_400 hint", () => {
    const text = formatToolError(new TraceApiError("boom", 500, "INTERNAL"));
    assert.match(text, /Error 500 INTERNAL/);
    assert.match(text, /server\/upstream fault/i);
    assert.equal(/resending it unchanged will fail again/i.test(text), false);
  });

  it("M2b: 400 keeps the invalid-request hint", () => {
    const text = formatToolError(
      new TraceApiError("title is required", 400, "VALIDATION"),
    );
    assert.match(text, /resending it unchanged will fail again/i);
  });
});
