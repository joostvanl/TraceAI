import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");

/**
 * TRA-77: catch regressions where a caller asks Aurora for at most 100 rows
 * and then filters in memory. Prefer `listAllEntries` (or a documented probe).
 */
describe("listEntries pagination guard", () => {
  it("service.ts never calls client.listEntries directly", () => {
    const src = readFileSync(join(here, "service.ts"), "utf8");
    assert.equal(
      src.includes("this.client.listEntries"),
      false,
      "TraceService must page via listAllEntries, not this.client.listEntries",
    );
  });

  it("migrate-relations.ts uses listAllEntries instead of capped listEntries", () => {
    const src = readFileSync(
      join(repoRoot, "apps/api/src/cli/migrate-relations.ts"),
      "utf8",
    );
    assert.match(src, /listAllEntries/);
    assert.equal(
      /listEntries\s*[<(]/.test(src),
      false,
      "migrate-relations must not call listEntries with a page cap",
    );
  });

  it("cms.ts project lists use listAllEntries / listEntriesForProject", () => {
    const src = readFileSync(
      join(repoRoot, "apps/web/src/lib/cms.ts"),
      "utf8",
    );
    assert.match(src, /listAllEntries/);
    assert.match(src, /listEntriesForProject/);
    // Comments still use an explicit offset loop (TRA-64); that is fine.
    // The five former capped reads must not regress to `limit: 100` alone.
    const cappedProjectReads = [
      ...src.matchAll(
        /listEntries<(?:Project|Workflow|Ticket|WikiPage)>\([^)]*\{\s*limit:\s*100/g,
      ),
    ];
    assert.equal(
      cappedProjectReads.length,
      0,
      "cms.ts must not list project/workflow/ticket/wiki with a lone limit:100",
    );
  });
});
