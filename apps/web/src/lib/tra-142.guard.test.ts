import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));

function read(rel: string): string {
  return readFileSync(join(srcDir, rel), "utf8");
}

describe("TRA-142 Features tab toggles live-board activity", () => {
  it("Settings has a Functies tab with ProjectFeaturesPanel", () => {
    const page = read("app/projects/[slug]/settings/page.tsx");
    assert.match(page, /tab=features/);
    assert.match(page, /ProjectFeaturesPanel/);
    assert.match(page, /Functies/);
  });

  it("panel fetches the live-board-activity BFF, not Aurora", () => {
    const panel = read("components/ProjectFeaturesPanel.tsx");
    assert.match(
      panel,
      /\/api\/projects\/\$\{encodeURIComponent\(projectSlug\)\}\/live-board-activity/,
    );
    assert.doesNotMatch(panel, /from "@\/lib\/cms"/);
    assert.match(panel, /canWrite/);
    assert.match(panel, /Alleen lezen/);
    assert.match(panel, /type="checkbox"/);
  });
});
