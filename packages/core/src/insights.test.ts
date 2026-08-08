import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeProjectInsights,
  paginateItems,
  searchProjectContent,
  sortTicketsNewestFirst,
} from "./insights.js";

const at = (iso: string) => iso;

describe("searchProjectContent", () => {
  const tickets = [
    {
      slug: "alpha-ticket",
      ticket_key: "TRA-1",
      title: "Add search API",
      description: "Implement project search across tickets",
      stage: "done",
      priority: "high",
      created_by: "Joost",
      resolution: "completed",
      stage_entered_at: at("2026-08-01T10:00:00.000Z"),
      commentBodies: ["Shipped search filters"],
      commentAuthors: ["Agent"],
    },
    {
      slug: "beta-ticket",
      ticket_key: "TRA-2",
      title: "Fix board cap",
      description: "Unrelated work",
      stage: "in_progress",
      priority: "medium",
      created_by: "Alice",
      stage_entered_at: at("2026-08-05T10:00:00.000Z"),
      commentBodies: [],
      commentAuthors: [],
    },
  ];

  const wikiPages = [
    {
      slug: "mcp-tools",
      title: "MCP tools",
      body: "Catalogue of search_project and other tools",
      updatedAt: at("2026-08-02T10:00:00.000Z"),
    },
  ];

  it("matches tickets by key, title, description, and comments", () => {
    const byKey = searchProjectContent({
      tickets,
      wikiPages,
      filters: { q: "tra-1", type: "ticket" },
    });
    assert.equal(byKey.length, 1);
    assert.equal(byKey[0]?.slug, "alpha-ticket");

    const byComment = searchProjectContent({
      tickets,
      wikiPages,
      filters: { q: "filters", type: "ticket" },
    });
    assert.equal(byComment.length, 1);
    assert.equal(byComment[0]?.type, "ticket");
  });

  it("matches wiki pages and uses type discriminator", () => {
    const hits = searchProjectContent({
      tickets,
      wikiPages,
      filters: { q: "search" },
    });
    assert.ok(hits.some((h) => h.type === "wiki_page" && h.slug === "mcp-tools"));
    assert.ok(hits.some((h) => h.type === "ticket"));
    assert.ok(hits.every((h) => h.type === "ticket" || h.type === "wiki_page"));
  });

  it("applies stage, resolution, priority, and actor filters", () => {
    const filtered = searchProjectContent({
      tickets,
      wikiPages,
      filters: {
        q: "",
        type: "ticket",
        stage: "done",
        resolution: "completed",
        priority: "high",
        created_by: "joost",
      },
    });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.slug, "alpha-ticket");

    const byCommentAuthor = searchProjectContent({
      tickets,
      wikiPages,
      filters: { type: "ticket", created_by: "agent" },
    });
    assert.equal(byCommentAuthor.length, 1);
  });

  it("filters by date range on stage_entered_at", () => {
    const hits = searchProjectContent({
      tickets,
      wikiPages: [],
      filters: {
        type: "ticket",
        from: "2026-08-04T00:00:00.000Z",
        to: "2026-08-06T00:00:00.000Z",
      },
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.slug, "beta-ticket");
  });

  it("excludes wiki when ticket-only filters are set", () => {
    const hits = searchProjectContent({
      tickets,
      wikiPages,
      filters: { stage: "done" },
    });
    assert.ok(hits.every((h) => h.type === "ticket"));
  });
});

describe("paginateItems / history", () => {
  it("paginates beyond the board Done window of 20", () => {
    const tickets = Array.from({ length: 35 }, (_, i) => ({
      slug: `t-${i}`,
      title: `Ticket ${i}`,
      stage: "done",
      stage_entered_at: at(
        `2026-07-${String((i % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
      ),
    }));
    const newest = sortTicketsNewestFirst(tickets);
    const page1 = paginateItems(newest, 20, 0);
    const page2 = paginateItems(newest, 20, 20);
    assert.equal(page1.total, 35);
    assert.equal(page1.items.length, 20);
    assert.equal(page2.items.length, 15);
    assert.notEqual(page1.items[0]?.slug, page2.items[0]?.slug);
  });
});

describe("computeProjectInsights", () => {
  it("aggregates throughput, resolution mix, and estimate accuracy", () => {
    const tickets = [
      {
        slug: "a",
        ticket_key: "TRA-10",
        title: "A",
        stage: "done",
        stage_entered_at: "2026-08-03T10:00:00.000Z",
        resolution: "completed",
        tokens_estimate: 1000,
        tokens_actual: 500,
      },
      {
        slug: "b",
        ticket_key: "TRA-11",
        title: "B",
        stage: "done",
        stage_entered_at: "2026-08-04T10:00:00.000Z",
        resolution: "cancelled",
        tokens_estimate: 1000,
        tokens_actual: 2000,
      },
      {
        slug: "c",
        ticket_key: "TRA-12",
        title: "C",
        stage: "in_progress",
        stage_entered_at: "2026-08-01T10:00:00.000Z",
        tokens_estimate: 500,
        tokens_actual: null,
      },
    ];

    const insights = computeProjectInsights(tickets, {
      now: new Date("2026-08-08T12:00:00.000Z"),
    });

    assert.equal(insights.done_stage, "done");
    assert.ok(insights.throughput_per_week.some((w) => w.count === 2));
    assert.equal(insights.open_wip.count, 1);
    assert.ok((insights.open_wip.avg_age_days ?? 0) >= 7);
    assert.equal(insights.estimate_vs_actual.sample_size, 2);
    assert.equal(insights.estimate_vs_actual.under_estimate_count, 1);
    assert.equal(insights.estimate_vs_actual.over_estimate_count, 1);
    assert.ok(
      insights.resolution_mix.some(
        (r) => r.resolution === "completed" && r.count === 1,
      ),
    );
    assert.equal(insights.review_returns, 0);
  });
});
