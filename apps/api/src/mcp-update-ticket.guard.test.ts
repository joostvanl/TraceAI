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

describe("MCP update_ticket has no workflow (TRA-95 T9)", () => {
  it("T9: update_ticket schema does not accept workflow", () => {
    const start = source.indexOf('"update_ticket"');
    assert.ok(start >= 0);
    const next = source.indexOf("server.tool(", start + 10);
    const tool = source.slice(start, next > start ? next : undefined);
    assert.doesNotMatch(tool, /workflow:\s*z/);
  });
});
