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

describe("MCP set_ticket_activity (TRA-141)", () => {
  it("registers set_ticket_activity as its own tool, not add_comment", () => {
    const start = source.indexOf('"set_ticket_activity"');
    assert.ok(start >= 0);
    const next = source.indexOf("server.tool(", start + 10);
    const tool = source.slice(start, next > start ? next : undefined);
    assert.match(tool, /ticket/);
    assert.match(tool, /text/);
    assert.match(tool, /TTL 120s/);
    assert.match(tool, /max 80/);
    assert.doesNotMatch(tool, /add_comment/);
  });
});
