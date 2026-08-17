import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectWikiPages, sortWikiPages } from "./wiki-pages.js";
import { WIKI_PAGE_LIST_MAX, type WikiPage } from "./types.js";

function page(
  slug: string,
  overrides: Partial<WikiPage["fields"]> = {},
): WikiPage {
  return {
    id: `id-${slug}`,
    slug,
    updatedAt: "2026-08-17T00:00:00.000Z",
    fields: {
      title: slug,
      body: `body of ${slug}`,
      project: "traceai",
      parent: null,
      sort_order: 0,
      ...overrides,
    },
  } as WikiPage;
}

describe("sortWikiPages", () => {
  it("orders by sort_order, then title", () => {
    const sorted = sortWikiPages([
      page("b", { sort_order: 1, title: "B" }),
      page("z", { sort_order: 0, title: "Z" }),
      page("a", { sort_order: 0, title: "A" }),
    ]);
    assert.deepEqual(
      sorted.map((p) => p.slug),
      ["a", "z", "b"],
    );
  });

  it("does not mutate the input", () => {
    const pages = [page("b", { sort_order: 1 }), page("a", { sort_order: 0 })];
    sortWikiPages(pages);
    assert.deepEqual(
      pages.map((p) => p.slug),
      ["b", "a"],
    );
  });
});

describe("selectWikiPages", () => {
  const tree = [
    page("home", { sort_order: 0, title: "Home" }),
    page("design-packs", { sort_order: 1, title: "Design packs" }),
    page("tra-68-design", {
      parent: "design-packs",
      sort_order: 0,
      title: "TRA-68",
    }),
    page("tra-69-design", {
      parent: "design-packs",
      sort_order: 1,
      title: "TRA-69",
    }),
  ];

  it("returns every page with total when no limit is given", () => {
    const result = selectWikiPages({ pages: tree });
    assert.equal(result.items.length, 4);
    assert.equal(result.total, 4);
    assert.equal(result.offset, 0);
  });

  it("filters on parent", () => {
    const result = selectWikiPages({ pages: tree, parent: "design-packs" });
    assert.deepEqual(
      result.items.map((p) => p.slug),
      ["tra-68-design", "tra-69-design"],
    );
    assert.equal(result.total, 2);
  });

  it("treats empty-string and null parent as root pages", () => {
    for (const parent of ["", null]) {
      const result = selectWikiPages({ pages: tree, parent });
      assert.deepEqual(
        result.items.map((p) => p.slug),
        ["home", "design-packs"],
      );
    }
  });

  it("slices with limit/offset while total stays the unsliced count", () => {
    const result = selectWikiPages({ pages: tree, limit: 2, offset: 1 });
    assert.equal(result.items.length, 2);
    assert.equal(result.total, 4, "total must expose what the slice hides");
    assert.equal(result.limit, 2);
    assert.equal(result.offset, 1);
  });

  it("counts after the parent filter, not before", () => {
    const result = selectWikiPages({
      pages: tree,
      parent: "design-packs",
      limit: 1,
    });
    assert.equal(result.total, 2);
  });

  it("clamps nonsense limits instead of returning nothing", () => {
    assert.equal(selectWikiPages({ pages: tree, limit: 0 }).limit, WIKI_PAGE_LIST_MAX);
    assert.equal(selectWikiPages({ pages: tree, limit: -5 }).limit, 1);
    assert.equal(
      selectWikiPages({ pages: tree, limit: 10_000 }).limit,
      WIKI_PAGE_LIST_MAX,
    );
    assert.equal(selectWikiPages({ pages: tree, offset: -3 }).offset, 0);
  });

  it("hands back more than a hundred pages in one call", () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      page(`p-${String(i).padStart(3, "0")}`, { sort_order: i }),
    );
    const result = selectWikiPages({ pages: many });
    assert.equal(result.total, 250);
    assert.equal(result.items.length, 250, "no silent cap at 100");
  });
});
