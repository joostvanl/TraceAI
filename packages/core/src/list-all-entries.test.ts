import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ListEntriesQuery } from "./aurora.js";
import {
  listAllEntries,
  type EntriesPage,
  type EntriesReader,
} from "./list-all-entries.js";

function stubReader(
  pages: Map<number, EntriesPage<{ slug: string }>>,
  calls: Array<{ offset: number; query: Record<string, unknown> }>,
): EntriesReader {
  return {
    async listEntries<T>(
      _apiId: string,
      query: ListEntriesQuery = {},
    ): Promise<EntriesPage<T>> {
      const offset = query.offset ?? 0;
      calls.push({ offset, query: { ...query } });
      const page = pages.get(offset);
      if (!page) {
        return { items: [] as T[], total: 0 };
      }
      return page as EntriesPage<T>;
    },
  };
}

function makeItems(count: number, start = 0) {
  return Array.from({ length: count }, (_, i) => ({
    slug: `item-${start + i}`,
  }));
}

describe("listAllEntries", () => {
  it("T1: returns all 250 entries across three requests", async () => {
    const calls: Array<{ offset: number; query: Record<string, unknown> }> = [];
    const client = stubReader(
      new Map([
        [0, { items: makeItems(100, 0), total: 250 }],
        [100, { items: makeItems(100, 100), total: 250 }],
        [200, { items: makeItems(50, 200), total: 250 }],
      ]),
      calls,
    );
    const items = await listAllEntries(client, "ticket");
    assert.equal(items.length, 250);
    assert.deepEqual(
      calls.map((c) => c.offset),
      [0, 100, 200],
    );
  });

  it("T2: stops after exact 100 without a second empty request", async () => {
    const calls: Array<{ offset: number; query: Record<string, unknown> }> = [];
    const client = stubReader(
      new Map([[0, { items: makeItems(100), total: 100 }]]),
      calls,
    );
    const items = await listAllEntries(client, "ticket");
    assert.equal(items.length, 100);
    assert.equal(calls.length, 1);
  });

  it("T3: returns empty array with one request", async () => {
    const calls: Array<{ offset: number; query: Record<string, unknown> }> = [];
    const client = stubReader(new Map([[0, { items: [], total: 0 }]]), calls);
    const items = await listAllEntries(client, "ticket");
    assert.deepEqual(items, []);
    assert.equal(calls.length, 1);
  });

  it("T4: forwards field/in on every page request", async () => {
    const calls: Array<{ offset: number; query: Record<string, unknown> }> = [];
    const client = stubReader(
      new Map([
        [0, { items: makeItems(100), total: 150 }],
        [100, { items: makeItems(50, 100), total: 150 }],
      ]),
      calls,
    );
    await listAllEntries(client, "ticket", {
      field: "project",
      in: ["traceai"],
      status: "published",
    });
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.query.field, "project");
      assert.deepEqual(call.query.in, ["traceai"]);
      assert.equal(call.query.status, "published");
      assert.equal(call.query.limit, 100);
    }
  });

  it("T5: stops when total is smaller than collected items", async () => {
    const calls: Array<{ offset: number; query: Record<string, unknown> }> = [];
    const client = stubReader(
      new Map([
        [0, { items: makeItems(100), total: 80 }],
        [100, { items: makeItems(100, 100), total: 80 }],
      ]),
      calls,
    );
    const items = await listAllEntries(client, "ticket");
    assert.equal(items.length, 100);
    assert.equal(calls.length, 1);
  });

  it("T6: works with an object that only has listEntries", async () => {
    const onlyListEntries: EntriesReader = {
      async listEntries<T>() {
        return { items: [{ slug: "a" }] as T[], total: 1 };
      },
    };
    const items = await listAllEntries<{ slug: string }>(
      onlyListEntries,
      "project",
    );
    assert.deepEqual(items, [{ slug: "a" }]);
  });
});
