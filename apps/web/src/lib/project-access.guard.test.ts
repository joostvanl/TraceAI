import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));
const appDir = join(srcDir, "app");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Every file under app/projects/[slug] and app/api/projects/[slug]. */
function projectScopedFiles(): string[] {
  const roots = [
    join(appDir, "projects", "[slug]"),
    join(appDir, "api", "projects", "[slug]"),
  ];
  return roots
    .flatMap((root) => walk(root))
    .filter((f) => f.endsWith("page.tsx") || f.endsWith("route.ts") || f.endsWith("layout.tsx"));
}

/**
 * Files that need no local check because every read they do goes through a
 * project-scoped TraceAI API path, which the API's own middleware already gates —
 * and whose 404 they forward verbatim. Adding a check there would only cost an
 * extra round-trip. The exemption is a list on purpose: a new file has to be
 * added here deliberately, with a reason, instead of slipping through.
 */
const PROXY_ONLY: Record<string, string> = {
  "api/projects/[slug]/members/route.ts":
    "proxies GET/POST /v1/projects/:slug/members and forwards the API status",
  "api/projects/[slug]/members/[user]/route.ts":
    "proxies DELETE /v1/projects/:slug/members/:user and forwards the API status",
  "api/projects/[slug]/default-agent/route.ts":
    "proxies GET/PUT /v1/projects/:slug/default-agent and forwards the API status",
  "api/projects/[slug]/agents/route.ts":
    "proxies GET/PUT /v1/projects/:slug/agents and forwards the API status",
};

/**
 * TRA-81: the API middleware protects the API, but these pages read their data
 * straight from Aurora (TRA-78), so the only membership check they have is the
 * explicit call in the file. This test is what keeps that from being forgotten —
 * without it the next page added under `[slug]` silently exposes every project.
 */
describe("web project access coverage (TRA-81)", () => {
  const files = projectScopedFiles();

  it("finds the project-scoped pages and routes", () => {
    assert.ok(
      files.length >= 8,
      `expected the project pages and workflow routes, found ${files.length}`,
    );
  });

  for (const file of files) {
    const label = relative(appDir, file).split(sep).join("/");
    const exemption = PROXY_ONLY[label];
    it(
      exemption
        ? `${label} is exempt: ${exemption}`
        : `${label} checks project access`,
      () => {
        const source = readFileSync(file, "utf8");
        const guarded =
          /requireProjectAccess\(/.test(source) ||
          /hasProjectAccess\(/.test(source);
        if (exemption) {
          // The exemption only holds while the file really is a pure proxy: as
          // soon as it reads Aurora through lib/cms it needs its own check.
          assert.ok(
            !/from "@\/lib\/cms"/.test(source) || guarded,
            `${label} is exempt as a pure proxy but now reads @/lib/cms — either add a check or remove the exemption`,
          );
          return;
        }
        assert.ok(
          guarded,
          `${label} must call requireProjectAccess (page/layout) or hasProjectAccess (route handler) before reading project data`,
        );
      },
    );
  }

  it("no exemption is stale", () => {
    const labels = new Set(
      files.map((f) => relative(appDir, f).split(sep).join("/")),
    );
    const stale = Object.keys(PROXY_ONLY).filter((k) => !labels.has(k));
    assert.deepEqual(stale, [], `remove these dead exemptions: ${stale.join(", ")}`);
  });
});
