import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ProjectIndexLruCache,
  ProjectSearchIndex,
  searchIndexedContent,
  tokenizeForRetrieval,
  type SearchTicketInput,
} from "./search-index.js";

function ticket(
  slug: string,
  key: string,
  title: string,
  description = "",
  stage = "in_progress",
): SearchTicketInput {
  return {
    slug,
    ticket_key: key,
    title,
    description,
    stage,
    priority: "medium",
    commentBodies: [],
    commentAuthors: [],
  };
}

describe("search tokenizer", () => {
  it("keeps compound ticket keys and short numeric tokens", () => {
    assert.deepEqual(tokenizeForRetrieval("TRA-83"), ["tra-83", "tra", "83"]);
    assert.deepEqual(tokenizeForRetrieval("TRA-83", { keyQuery: true }), [
      "tra-83",
    ]);
    assert.deepEqual(tokenizeForRetrieval("83"), ["83"]);
  });

  it("drops stopwords and one-to-two-letter words", () => {
    assert.deepEqual(tokenizeForRetrieval("de het een ui db FO"), []);
  });
});

describe("ProjectSearchIndex ranking", () => {
  it("isolates exact ticket-key queries from the shared project prefix", () => {
    const index = new ProjectSearchIndex([
      ticket("one", "TRA-1", "First"),
      ticket("two", "TRA-2", "Second"),
      ticket("reference", "TRA-3", "Mentions another", "See TRA-1"),
    ]);
    const result = index.search({ q: "tra-1", type: "ticket" });
    assert.equal(result.hits[0]?.slug, "one");
    assert.deepEqual(
      result.hits.map((hit) => hit.slug),
      ["one", "reference"],
    );
  });

  it("supports prefix matching but not mid-word matching", () => {
    const index = new ProjectSearchIndex([
      ticket("refine", "TRA-1", "In Refinement"),
    ]);
    assert.equal(index.search({ q: "refine" }).hits.length, 1);
    assert.equal(index.search({ q: "fine" }).hits.length, 0);
  });

  it("returns no hits for non-empty queries without usable tokens", () => {
    const index = new ProjectSearchIndex([
      ticket("ui", "TRA-1", "UI and live board"),
    ]);
    assert.equal(index.search({ q: "de het een" }).hits.length, 0);
    assert.equal(index.search({ q: "ui" }).hits.length, 0);
    assert.equal(index.search({ q: "" }).hits.length, 1);
  });

  it("finds short numeric ticket tokens", () => {
    const index = new ProjectSearchIndex([
      ticket("target", "TRA-83", "Target"),
      ticket("other", "TRA-84", "Other"),
    ]);
    assert.deepEqual(
      index.search({ q: "83" }).hits.map((hit) => hit.slug),
      ["target"],
    );
  });

  it("ranks documents matching more query terms first", () => {
    const index = new ProjectSearchIndex([
      ticket("both", "TRA-1", "Search", "Filters implementation"),
      ticket("one", "TRA-2", "Search", "Unrelated"),
    ]);
    assert.equal(index.search({ q: "search filters" }).hits[0]?.slug, "both");
  });

  it("ranks a title match above a body-only match", () => {
    const index = new ProjectSearchIndex([
      ticket("title", "TRA-1", "Distinctive subject"),
      ticket(
        "body",
        "TRA-2",
        "Generic item",
        `${"filler ".repeat(40)}distinctive`,
      ),
    ]);
    assert.equal(index.search({ q: "distinctive" }).hits[0]?.slug, "title");
  });

  it("keeps project indexes isolated", () => {
    const projectA = new ProjectSearchIndex([
      ticket("a", "AAA-1", "Alpha only"),
    ]);
    const projectB = new ProjectSearchIndex([
      ticket("b", "BBB-1", "Private beta term"),
    ]);
    assert.equal(projectA.search({ q: "private" }).hits.length, 0);
    assert.equal(projectB.search({ q: "private" }).hits.length, 1);
  });

  it("updates and removes individual indexed documents", () => {
    const index = new ProjectSearchIndex(
      [ticket("one", "TRA-1", "Old title")],
      [{ slug: "guide", title: "Old guide", body: "legacy wiki" }],
    );
    index.upsertTicket(ticket("one", "TRA-1", "Fresh searchable title"));
    index.upsertWikiPage({
      slug: "guide",
      title: "Fresh guide",
      body: "current wiki",
    });
    assert.equal(index.search({ q: "fresh", type: "ticket" }).hits.length, 1);
    assert.equal(
      index.search({ q: "current", type: "wiki_page" }).hits.length,
      1,
    );
    assert.equal(index.search({ q: "legacy" }).hits.length, 0);
    index.deleteWikiPage("guide");
    assert.equal(index.search({ q: "current" }).hits.length, 0);
  });

  it("applies ticket filters without hiding Done by default", () => {
    const index = new ProjectSearchIndex([
      ticket("done", "TRA-1", "Search done", "", "done"),
      ticket("open", "TRA-2", "Search open", "", "in_progress"),
    ]);
    assert.equal(index.search({ q: "search" }).hits.length, 2);
    assert.deepEqual(
      index.search({ q: "search", stage: "done" }).hits.map((hit) => hit.slug),
      ["done"],
    );
  });

  it("returns compact profile snippets and supports no-preview mode", () => {
    const longText = `needle ${"content ".repeat(80)}`;
    const focused = searchIndexedContent({
      tickets: [ticket("one", "TRA-1", "Needle", longText)],
      filters: { q: "needle" },
      options: { profile: "focused" },
    });
    assert.ok((focused.hits[0]?.snippet.length ?? 0) <= 90);
    const hidden = searchIndexedContent({
      tickets: [ticket("one", "TRA-1", "Needle", longText)],
      filters: { q: "needle" },
      options: { includePreview: false },
    });
    assert.equal(hidden.hits[0]?.snippet, "");
  });

  it("reports deterministic prefix truncation", () => {
    const tickets = Array.from({ length: 40 }, (_, index) =>
      ticket(
        `t-${index}`,
        `TRA-${index + 1}`,
        `Prefix prefixword${String(index).padStart(2, "0")}`,
      ),
    );
    const result = new ProjectSearchIndex(tickets).search({ q: "prefix" });
    assert.equal(result.meta.prefix_expansions_truncated, true);
    assert.ok(result.hits.length > 0);
  });
});

describe("ProjectIndexLruCache", () => {
  it("expires indexes after the five-minute TTL", () => {
    let now = 1_000;
    const cache = new ProjectIndexLruCache<string>(
      300_000,
      2,
      () => now,
    );
    cache.set("traceai", "index");
    now += 300_000;
    assert.equal(cache.get("traceai")?.value, "index");
    now += 1;
    assert.equal(cache.get("traceai"), undefined);
  });

  it("keeps only the two most recently used projects", () => {
    let now = 0;
    const cache = new ProjectIndexLruCache<string>(300_000, 2, () => now++);
    cache.set("a", "A");
    cache.set("b", "B");
    cache.get("a");
    cache.set("c", "C");
    assert.deepEqual(cache.projects(), ["a", "c"]);
    assert.equal(cache.get("b"), undefined);
  });
});
