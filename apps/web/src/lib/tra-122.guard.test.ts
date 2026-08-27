import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));

describe("TRA-122 default agent on Agent APIs", () => {
  it("panel has a Default agent field separate from the API-key form", () => {
    const source = readFileSync(
      join(srcDir, "components", "AccountAgentApisPanel.tsx"),
      "utf8",
    );
    assert.match(source, /Default agent/);
    assert.match(source, /placeholder="bc-…"/);
    assert.match(source, /\/api\/account\/default-agent/);
    assert.match(source, /\/api\/account\/agent-apis/);
    assert.match(source, /JSON\.stringify\(\{ agent_id: defaultAgentDraft \}\)/);
    assert.doesNotMatch(source, /api_key: defaultAgentDraft/);
  });

  it("shows the stored id in full, not truncated", () => {
    const source = readFileSync(
      join(srcDir, "components", "AccountAgentApisPanel.tsx"),
      "utf8",
    );
    assert.match(source, /Huidig: <code>\{defaultAgentId\}<\/code>/);
    assert.doesNotMatch(source, /slice\(0,\s*12\)/);
  });
});
