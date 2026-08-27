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

describe("MCP set_default_agent (TRA-122)", () => {
  it("registers set_default_agent with metadata-socket docs, not URL paste", () => {
    const start = source.indexOf('"set_default_agent"');
    assert.ok(start >= 0);
    const next = source.indexOf("server.tool(", start + 10);
    const tool = source.slice(start, next > start ? next : undefined);
    assert.match(tool, /meta-data\/agent\/id/);
    assert.doesNotMatch(tool, /copy the .*URL/i);
    assert.match(tool, /Empty agent_id clears/);
    assert.match(tool, /project slug/);
    assert.match(tool, /this project's membership default only/);
    assert.doesNotMatch(tool, /display_name/);
    assert.doesNotMatch(tool, /weergave/i);
    assert.match(source, /project: z/);
    assert.match(source, /putProjectDefaultAgent\(project, agent_id\)/);
    assert.doesNotMatch(source, /putMyDefaultAgent/);
  });
});
