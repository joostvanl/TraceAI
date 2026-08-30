import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));

describe("TRA-128 default agent lives in Settings, not Agent APIs", () => {
  it("Agent APIs Cursor panel has no Default agent field", () => {
    const source = readFileSync(
      join(srcDir, "components", "AccountAgentApisPanel.tsx"),
      "utf8",
    );
    assert.doesNotMatch(source, /Default agent/);
    assert.doesNotMatch(source, /\/api\/account\/default-agent/);
    assert.doesNotMatch(source, /default_cursor_agent_id/);
    assert.match(source, /\/api\/account\/agent-apis/);
  });

  it("Settings has a Default agent tab with full bc- id Save/Clear", () => {
    const page = readFileSync(
      join(srcDir, "app", "projects", "[slug]", "settings", "page.tsx"),
      "utf8",
    );
    const panel = readFileSync(
      join(srcDir, "components", "ProjectDefaultAgentPanel.tsx"),
      "utf8",
    );
    assert.match(page, /tab=default-agent/);
    assert.match(page, /ProjectDefaultAgentPanel/);
    assert.match(panel, /Default agent/);
    assert.match(panel, /placeholder="bc-…"/);
    assert.match(panel, /\/api\/projects\/\$\{encodeURIComponent\(projectSlug\)\}\/default-agent/);
    assert.match(panel, /Huidig: <code>\{agentId\}<\/code>/);
    assert.match(panel, /canWrite/);
    assert.match(panel, /Alleen lezen/);
    assert.match(panel, /readOnly=\{!canWrite\}/);
    assert.doesNotMatch(panel, /slice\(0,\s*12\)/);
    assert.doesNotMatch(panel, /<select/);
    assert.match(page, /canWrite=\{/);
  });
});
