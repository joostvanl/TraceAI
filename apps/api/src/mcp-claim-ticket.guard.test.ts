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

describe("MCP claim_ticket (TRA-107)", () => {
  it("registers claim_ticket with metadata-socket docs, not URL paste", () => {
    const start = source.indexOf('"claim_ticket"');
    assert.ok(start >= 0);
    const next = source.indexOf("server.tool(", start + 10);
    const tool = source.slice(start, next > start ? next : undefined);
    assert.match(tool, /meta-data\/agent\/id/);
    assert.doesNotMatch(tool, /copy the .*URL/i);
  });
});
