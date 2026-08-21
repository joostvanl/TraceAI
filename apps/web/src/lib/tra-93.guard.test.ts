import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe("TRA-93 WorkflowSwitcher removal", () => {
  it("T9: WorkflowSwitcher is not imported", () => {
    const hits = walk(srcDir).filter((file) => {
      if (!/\.(tsx?|css)$/.test(file)) return false;
      if (file.endsWith(".test.ts")) return false;
      const source = readFileSync(file, "utf8");
      return (
        source.includes("WorkflowSwitcher") ||
        source.includes("components/WorkflowSwitcher")
      );
    });
    assert.deepEqual(
      hits.map((h) => h.slice(srcDir.length + 1)),
      [],
    );
  });

  it("T13: project menu API-tokens stays under /projects/:slug/tokens", () => {
    const sidebar = readFileSync(
      join(srcDir, "components", "ProjectSidebar.tsx"),
      "utf8",
    );
    assert.match(sidebar, /\/projects\/\$\{slug\}\/tokens/);
    assert.doesNotMatch(sidebar, /\/account\/tokens/);
  });
});
