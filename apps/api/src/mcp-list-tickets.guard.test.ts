import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(here, "../../../packages/mcp/src/register-tools.ts"),
  "utf8",
);

describe("MCP list_tickets workflow filter (TRA-87 M1/M2)", () => {
  it("M1: list_tickets schema has optional workflow", () => {
    const tool = source.slice(source.indexOf('"list_tickets"'));
    assert.match(tool, /workflow:\s*z\s*\.\s*string\(\)\s*\.\s*optional\(\)/);
  });

  it("M2: tool description mentions the workflow filter", () => {
    const start = source.indexOf('"list_tickets"');
    const description = source.slice(start, start + 400);
    assert.match(description, /workflow/i);
  });
});
