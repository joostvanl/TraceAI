import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ListEntriesQuery } from "./aurora.js";
import type { EntriesPage, EntriesReader } from "./list-all-entries.js";
import { listEntriesForProject } from "./list-entries-for-project.js";
import { relationSlug } from "./relations.js";

type Row = {
  slug: string;
  fields: { project: string | { slug: string }; sort_order?: number; title?: string };
};

function pagingClient(rows: Row[]): EntriesReader {
  return {
    async listEntries<T>(
      _apiId: string,
      query: ListEntriesQuery = {},
    ): Promise<EntriesPage<T>> {
      let filtered = rows;
      if (query.field === "project" && query.in) {
        const want = new Set(
          (Array.isArray(query.in) ? query.in : [query.in]).map(String),
        );
        filtered = rows.filter((row) => {
          const p =
            typeof row.fields.project === "string"
              ? row.fields.project
              : row.fields.project.slug;
          return want.has(p);
        });
      }
      const offset = query.offset ?? 0;
      const limit = query.limit ?? 100;
      return {
        items: filtered.slice(offset, offset + limit) as T[],
        total: filtered.length,
      };
    },
  };
}

describe("listEntriesForProject (TRA-75)", () => {
  it("T7: returns project rows past global entry 100", async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 120; i++) {
      rows.push({ slug: `other-${i}`, fields: { project: "other", sort_order: i } });
    }
    for (let i = 0; i < 30; i++) {
      rows.push({
        slug: `mine-${i}`,
        fields: { project: "traceai", sort_order: 100 - i },
      });
    }
    const items = await listEntriesForProject<Row>(
      pagingClient(rows),
      "ticket",
      "traceai",
      (row) => relationSlug(row.fields.project),
    );
    assert.equal(items.length, 30);
    assert.ok(items.some((t) => t.slug === "mine-0"));
    assert.ok(items.some((t) => t.slug === "mine-29"));
  });

  it("T8: returns the full wiki set for a project", async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 110; i++) {
      rows.push({
        slug: `other-wp-${i}`,
        fields: { project: "other", title: `O${i}`, sort_order: i },
      });
    }
    for (let i = 0; i < 20; i++) {
      rows.push({
        slug: `mine-wp-${i}`,
        fields: { project: "traceai", title: `M${i}`, sort_order: i },
      });
    }
    const items = await listEntriesForProject<Row>(
      pagingClient(rows),
      "wiki_page",
      "traceai",
      (row) => relationSlug(row.fields.project),
    );
    assert.equal(items.length, 20);
  });

  it("T9: falls back to a full scan when field/in matches nothing", async () => {
    const rows: Row[] = [
      { slug: "home", fields: { project: { slug: "traceai" }, title: "Home" } },
      {
        slug: "arch",
        fields: { project: { slug: "traceai" }, title: "Architecture" },
      },
    ];
    let scopedCalls = 0;
    let unscopedCalls = 0;
    const client: EntriesReader = {
      async listEntries<T>(
        _apiId: string,
        query: ListEntriesQuery = {},
      ): Promise<EntriesPage<T>> {
        if (query.field === "project") {
          scopedCalls += 1;
          return { items: [] as T[], total: 0 };
        }
        unscopedCalls += 1;
        const offset = query.offset ?? 0;
        const limit = query.limit ?? 100;
        return {
          items: rows.slice(offset, offset + limit) as T[],
          total: rows.length,
        };
      },
    };
    const result = await listEntriesForProject<Row>(
      client,
      "wiki_page",
      "traceai",
      (p) => relationSlug(p.fields.project),
    );
    assert.equal(result.length, 2);
    assert.ok(scopedCalls >= 1);
    assert.ok(unscopedCalls >= 1);
  });

  it("T10: callers can sort by sort_order ascending after fetch", async () => {
    const rows: Row[] = [
      { slug: "c", fields: { project: "traceai", sort_order: 2 } },
      { slug: "a", fields: { project: "traceai", sort_order: 0 } },
      { slug: "b", fields: { project: "traceai", sort_order: 1 } },
    ];
    const items = await listEntriesForProject<Row>(
      pagingClient(rows),
      "ticket",
      "traceai",
      (row) => relationSlug(row.fields.project),
    );
    items.sort(
      (a, b) => (a.fields.sort_order ?? 0) - (b.fields.sort_order ?? 0),
    );
    assert.deepEqual(
      items.map((t) => t.slug),
      ["a", "b", "c"],
    );
  });
});
