import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));

function read(rel: string): string {
  return readFileSync(join(srcDir, rel), "utf8");
}

describe("TRA-136 Agents tab sets project_agent display names", () => {
  it("Settings has an Agents tab with ProjectAgentsPanel", () => {
    const page = read("app/projects/[slug]/settings/page.tsx");
    assert.match(page, /tab=agents/);
    assert.match(page, /ProjectAgentsPanel/);
    assert.match(page, /membershipRole === "editor"/);
  });

  it("panel fetches the project agents BFF, not Aurora or Agent APIs", () => {
    const panel = read("components/ProjectAgentsPanel.tsx");
    assert.match(
      panel,
      /\/api\/projects\/\$\{encodeURIComponent\(projectSlug\)\}\/agents/,
    );
    assert.match(
      panel,
      /\/api\/projects\/\$\{encodeURIComponent\(projectSlug\)\}\/default-agent/,
    );
    assert.doesNotMatch(panel, /from "@\/lib\/cms"/);
    assert.doesNotMatch(panel, /\/api\/account\/agent-apis/);
    assert.doesNotMatch(panel, /slice\(0,\s*12\)/);
    assert.doesNotMatch(panel, /<select/);
    assert.match(panel, /canWrite/);
    assert.match(panel, /Alleen lezen/);
    assert.match(panel, /readOnly=\{!canWrite\}/);
    assert.match(panel, /placeholder="bc-…"/);
  });
});
