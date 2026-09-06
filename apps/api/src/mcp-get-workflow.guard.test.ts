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

describe("MCP get_workflow catalog hint (TRA-156)", () => {
  it("tells agents to reload MCP when get_workflow_stage is missing", () => {
    const start = source.indexOf('"get_workflow"');
    const description = source.slice(start, start + 900);
    assert.match(description, /reload the TraceAI MCP/);
    assert.match(description, /get_workflow_stage/);
  });
});
