import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");

/**
 * TRA-79 G1: after converting not-found throws to NotFoundError, no production
 * `throw new Error(...)` in core/api may still contain "not found" in the
 * message. A leftover becomes HTTP 500 once the onError regex is gone.
 */
function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (
      name === "node_modules" ||
      name === "dist" ||
      name === "cli" ||
      name === "test-support.ts"
    ) {
      continue;
    }
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walkTsFiles(full));
      continue;
    }
    if (!name.endsWith(".ts")) continue;
    if (name.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

describe("not-found throw guard (TRA-79 G1)", () => {
  it("core + api production code has no throw new Error with 'not found' in the text", () => {
    const roots = [
      join(repoRoot, "packages/core/src"),
      join(repoRoot, "apps/api/src"),
    ];
    const leftovers: string[] = [];
    const probe = /throw\s+new\s+Error\s*\(([^;]{0,500})/g;

    for (const root of roots) {
      for (const file of walkTsFiles(root)) {
        const src = readFileSync(file, "utf8");
        probe.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = probe.exec(src))) {
          if (/not found/i.test(match[1])) {
            leftovers.push(
              `${relative(repoRoot, file).replaceAll("\\", "/")}: ${match[1].trim().slice(0, 120)}`,
            );
          }
        }
      }
    }

    assert.equal(
      leftovers.length,
      0,
      `leftover throw new Error with "not found":\n${leftovers.join("\n")}`,
    );
  });
});
