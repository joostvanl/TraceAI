import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../packages/mcp/src/register-tools.ts",
  ),
  "utf8",
);

describe("MCP create_ticket Cloud assignment contract (TRA-149)", () => {
  it("declares assign_cloud_agent as an optional boolean and forwards input", () => {
    const createTool = source.slice(
      source.indexOf('"create_ticket"'),
      source.indexOf('"update_ticket"'),
    );
    assert.match(
      createTool,
      /assign_cloud_agent:\s*z\.boolean\(\)\.optional\(\)/,
    );
    assert.match(createTool, /client\.createTicket\(input\)/);
    assert.doesNotMatch(createTool, /default\(true\)/);
  });
});
