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
});
