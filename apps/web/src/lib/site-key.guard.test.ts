import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));
const webDir = dirname(srcDir);
const staticDir = join(webDir, ".next", "static");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function siteKeyForSearch(): string | null {
  const fromEnv = process.env.CMS_SITE_KEY?.trim();
  if (fromEnv) return fromEnv;
  const envFile = join(webDir, ".env.local");
  if (!existsSync(envFile)) return null;
  const match = readFileSync(envFile, "utf8").match(/^CMS_SITE_KEY=(.+)$/m);
  return match?.[1]?.trim() || null;
}

/**
 * TRA-81. The Aurora site key grants read access to every project, ticket and
 * wiki page in the CMS, so a copy in the browser bundle would bypass every
 * membership check in this repo.
 *
 * That it does not leak today was an accident, not a measure: one `import`
 * instead of `import type` in a client component would be enough. These two
 * tests are the measure.
 */
describe("site key stays server-side (TRA-81)", () => {
  it("S1: the key value is in no client chunk", () => {
    // The test runner does not load .env.local, so fall back to reading it —
    // otherwise this test would silently skip on every developer machine.
    const key = siteKeyForSearch();
    if (!key) {
      // Nothing to search for; S2 still covers the import path. Reported so a
      // green run cannot be mistaken for a completed check.
      console.log("S1 skipped: CMS_SITE_KEY is not set in this environment");
      return;
    }
    if (!existsSync(staticDir)) {
      console.log("S1 skipped: no .next/static — run `pnpm build` first");
      return;
    }
    const hits = walk(staticDir).filter((file) =>
      readFileSync(file, "utf8").includes(key),
    );
    assert.deepEqual(
      hits.map((h) => h.slice(webDir.length + 1)),
      [],
      "the site key ended up in a client chunk",
    );
  });

  it("S2: no client component value-imports lib/cms", () => {
    const clientFiles = walk(srcDir).filter(
      (file) =>
        /\.tsx?$/.test(file) &&
        !file.endsWith(".test.ts") &&
        /^\s*["']use client["']/m.test(readFileSync(file, "utf8")),
    );
    assert.ok(
      clientFiles.length > 0,
      "expected to find client components; the search is probably broken",
    );

    const offenders = clientFiles.filter((file) => {
      const source = readFileSync(file, "utf8");
      return [...source.matchAll(/^\s*import\s+([\s\S]*?)from\s+["']([^"']+)["']/gm)]
        .filter(([, , spec]) => /(^|\/)lib\/cms$|^@\/lib\/cms$/.test(spec))
        // `import type { X }` is erased at compile time and carries no runtime
        // code; anything else pulls cms.ts — and the key — into the client.
        .some(([, clause]) => !/^\s*type\s/.test(clause));
    });

    assert.deepEqual(
      offenders.map((f) => f.slice(srcDir.length + 1)),
      [],
      "a client component imports values from lib/cms, which puts the Aurora site key in the browser bundle — use `import type` or move the read to a server component",
    );
  });

  it("the source no longer uses the NEXT_PUBLIC_ name", () => {
    const cms = readFileSync(join(srcDir, "lib", "cms.ts"), "utf8");
    assert.ok(
      !/process\.env\.NEXT_PUBLIC_CMS_SITE_KEY/.test(cms),
      "reading the prefixed name keeps the leak path alive",
    );
    assert.match(cms, /process\.env\.CMS_SITE_KEY/);
  });
});
