import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeEstimateVsActual,
  computeProjectInsights,
  paginateItems,
  searchProjectContent,
  sortTicketsNewestFirst,
} from "./insights.js";
import { ValidationError } from "./trace-errors.js";

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

function comparableDone(overrides: {
  slug: string;
  entered: string;
  estimate: number;
  actual: number;
  stage?: string;
  resolution?: string;
}) {
  return {
    slug: overrides.slug,
    ticket_key: overrides.slug.toUpperCase(),
    title: overrides.slug,
    stage: overrides.stage ?? "done",
    stage_entered_at: overrides.entered,
    resolution: overrides.resolution ?? "completed",
    tokens_estimate: overrides.estimate,
    tokens_actual: overrides.actual,
  };
}

describe("computeEstimateVsActual", () => {
  it("T1: default breakpoints split three comparable Done tickets and keep empty segments", () => {
    const result = computeEstimateVsActual([
      comparableDone({
        slug: "small",
        entered: "2026-08-03T10:00:00.000Z",
        estimate: 10000,
        actual: 8000,
      }),
      comparableDone({
        slug: "mid",
        entered: "2026-08-04T10:00:00.000Z",
        estimate: 40000,
        actual: 50000,
      }),
      comparableDone({
        slug: "large",
        entered: "2026-08-05T10:00:00.000Z",
        estimate: 90000,
        actual: 100000,
      }),
    ]);
    assert.equal(result.limit, 50);
    assert.deepEqual(result.breakpoints, [20000, 80000]);
    assert.equal(result.window.sample_size, 3);
    assert.equal(result.segments.length, 3);
    assert.equal(result.segments[0]?.label, "< 20000");
    assert.equal(result.segments[0]?.sample_size, 1);
    assert.equal(result.segments[1]?.label, "20000–80000");
    assert.equal(result.segments[1]?.sample_size, 1);
    assert.equal(result.segments[2]?.label, ">= 80000");
    assert.equal(result.segments[2]?.sample_size, 1);
  });

  it("T2: limit takes the newest eligible tickets and reports eligible_total", () => {
    const result = computeEstimateVsActual(
      [
        comparableDone({
          slug: "old",
          entered: "2026-08-01T10:00:00.000Z",
          estimate: 1000,
          actual: 1000,
        }),
        comparableDone({
          slug: "mid",
          entered: "2026-08-02T10:00:00.000Z",
          estimate: 1000,
          actual: 1000,
        }),
        comparableDone({
          slug: "new-a",
          entered: "2026-08-04T10:00:00.000Z",
          estimate: 1000,
          actual: 1000,
        }),
        comparableDone({
          slug: "new-b",
          entered: "2026-08-05T10:00:00.000Z",
          estimate: 1000,
          actual: 1000,
        }),
        comparableDone({
          slug: "new-c",
          entered: "2026-08-03T10:00:00.000Z",
          estimate: 1000,
          actual: 1000,
        }),
      ],
      { limit: 2 },
    );
    assert.equal(result.window.eligible_total, 5);
    assert.equal(result.window.sample_size, 2);
    assert.equal(result.window.newest_entered_at, "2026-08-05T10:00:00.000Z");
    assert.equal(result.window.oldest_entered_at, "2026-08-04T10:00:00.000Z");
    assert.equal(result.limit, 2);
  });

  it("T3: non-done tickets with both token fields are excluded", () => {
    const result = computeEstimateVsActual([
      comparableDone({
        slug: "done",
        entered: "2026-08-05T10:00:00.000Z",
        estimate: 1000,
        actual: 1000,
      }),
      comparableDone({
        slug: "wip",
        entered: "2026-08-06T10:00:00.000Z",
        estimate: 90000,
        actual: 90000,
        stage: "in_progress",
      }),
    ]);
    assert.equal(result.window.eligible_total, 1);
    assert.equal(result.window.sample_size, 1);
    assert.equal(result.overall.sample_size, 1);
  });

  it("T4: Done tickets missing estimate or actual are excluded", () => {
    const result = computeEstimateVsActual([
      comparableDone({
        slug: "ok",
        entered: "2026-08-05T10:00:00.000Z",
        estimate: 1000,
        actual: 1000,
      }),
      {
        slug: "no-actual",
        title: "no-actual",
        stage: "done",
        stage_entered_at: "2026-08-06T10:00:00.000Z",
        tokens_estimate: 1000,
        tokens_actual: null,
      },
      {
        slug: "no-estimate",
        title: "no-estimate",
        stage: "done",
        stage_entered_at: "2026-08-07T10:00:00.000Z",
        tokens_estimate: null,
        tokens_actual: 1000,
      },
    ]);
    assert.equal(result.window.eligible_total, 1);
  });

  it("T5: custom breakpoints=[10000] yield two buckets", () => {
    const result = computeEstimateVsActual(
      [
        comparableDone({
          slug: "under",
          entered: "2026-08-04T10:00:00.000Z",
          estimate: 8000,
          actual: 5000,
        }),
        comparableDone({
          slug: "over",
          entered: "2026-08-05T10:00:00.000Z",
          estimate: 12000,
          actual: 15000,
        }),
      ],
      { breakpoints: [10000] },
    );
    assert.equal(result.segments.length, 2);
    assert.equal(result.segments[0]?.label, "< 10000");
    assert.equal(result.segments[0]?.sample_size, 1);
    assert.equal(result.segments[1]?.label, ">= 10000");
    assert.equal(result.segments[1]?.sample_size, 1);
  });

  it("T6: invalid breakpoints throw ValidationError", () => {
    const cases = [[30000, 10000], [10000, 10000], [0], [10000, 20000, 30000, 40000, 50000, 60000, 70000, 80000, 90000]];
    for (const breakpoints of cases) {
      assert.throws(
        () => computeEstimateVsActual([], { breakpoints }),
        ValidationError,
      );
    }
  });

  it("T7: invalid limit throws ValidationError", () => {
    for (const limit of [0, -1, 201, 1.5]) {
      assert.throws(() => computeEstimateVsActual([], { limit }), ValidationError);
    }
  });

  it("T8: ratio bands match insights (0.9 / 1.1)", () => {
    const result = computeEstimateVsActual([
      comparableDone({
        slug: "under",
        entered: "2026-08-01T10:00:00.000Z",
        estimate: 1000,
        actual: 500,
      }),
      comparableDone({
        slug: "on",
        entered: "2026-08-02T10:00:00.000Z",
        estimate: 1000,
        actual: 1000,
      }),
      comparableDone({
        slug: "over",
        entered: "2026-08-03T10:00:00.000Z",
        estimate: 1000,
        actual: 2000,
      }),
    ]);
    assert.equal(result.overall.under_estimate_count, 1);
    assert.equal(result.overall.on_target_count, 1);
    assert.equal(result.overall.over_estimate_count, 1);
  });

  it("T9: buckets use own tokens_actual, not a rollup field", () => {
    const result = computeEstimateVsActual([
      comparableDone({
        slug: "parent",
        entered: "2026-08-05T10:00:00.000Z",
        estimate: 8000,
        actual: 5000,
      }),
    ]);
    assert.equal(result.segments[0]?.sample_size, 1);
    assert.equal(result.segments[1]?.sample_size, 0);
    assert.equal(result.segments[1]?.avg_ratio, null);
  });

  it("T10: omitted limit defaults to 50", () => {
    const tickets = Array.from({ length: 51 }, (_, i) =>
      comparableDone({
        slug: `t${i}`,
        entered: `2026-08-${String((i % 27) + 1).padStart(2, "0")}T10:00:00.000Z`,
        estimate: 1000,
        actual: 1000,
      }),
    );
    const result = computeEstimateVsActual(tickets);
    assert.equal(result.limit, 50);
    assert.equal(result.window.eligible_total, 51);
    assert.equal(result.window.sample_size, 50);
  });
});
