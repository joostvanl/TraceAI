import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TICKETS_PAGE_SIZE,
  filterTicketsByMeta,
  formatEntered,
  formatTokens,
  orderTicketsForList,
  pageTicketList,
  parseTicketListQuery,
  ticketListHref,
  uniqueStageKeys,
  type TicketListInput,
} from "./project-tickets.js";

function ticket(
  overrides: Partial<TicketListInput> & { slug: string; title: string },
): TicketListInput {
  return {
    ticket_key: null,
    workflow: "standard-worker",
    stage: "todo",
    priority: "medium",
    tokens_estimate: null,
    tokens_actual: null,
    stage_entered_at: null,
    resolution: null,
    description: "",
    commentBodies: [],
    ...overrides,
  };
}

const alpha = ticket({
  slug: "alpha-ticket",
  ticket_key: "TRA-1",
  title: "Add search API",
  description: "Implement project search across tickets",
  stage: "done",
  priority: "high",
  workflow: "story",
  resolution: "completed",
  stage_entered_at: "2026-08-01T10:00:00.000Z",
  commentBodies: ["Shipped search filters"],
});

const beta = ticket({
  slug: "beta-ticket",
  ticket_key: "TRA-2",
  title: "Fix board cap",
  description: "Unrelated work",
  stage: "in_progress",
  workflow: "standard-worker",
  stage_entered_at: "2026-08-05T10:00:00.000Z",
});

describe("TRA-94 project ticket list helpers", () => {
  it("parses URL query params and ignores invalid offset", () => {
    assert.deepEqual(
      parseTicketListQuery({
        q: "  refine  ",
        workflow: "story",
        stage: "done",
        priority: "high",
        resolution: "completed",
        offset: "25",
      }),
      {
        q: "refine",
        workflow: "story",
        stage: "done",
        priority: "high",
        resolution: "completed",
        offset: 25,
      },
    );
    assert.equal(parseTicketListQuery({ offset: "-4" }).offset, 0);
    assert.equal(parseTicketListQuery({ offset: "nope" }).offset, 0);
    assert.equal(parseTicketListQuery({ q: ["a", "b"] }).q, "a");
  });

  it("builds a shareable list href and omits empty filters / zero offset", () => {
    const query = parseTicketListQuery({
      q: "search",
      workflow: "story",
      offset: "25",
    });
    assert.equal(
      ticketListHref("traceai", query),
      "/projects/traceai/tickets?q=search&workflow=story&offset=25",
    );
    assert.equal(
      ticketListHref("traceai", query, 0),
      "/projects/traceai/tickets?q=search&workflow=story",
    );
    assert.equal(
      ticketListHref("traceai", parseTicketListQuery({})),
      "/projects/traceai/tickets",
    );
  });

  it("filters by workflow, stage, priority, and resolution without dropping subtickets", () => {
    const child = ticket({
      slug: "child",
      title: "Child",
      workflow: "story",
      stage: "todo",
    });
    const filtered = filterTicketsByMeta([alpha, beta, child], {
      workflow: "story",
      stage: "",
      priority: "",
      resolution: "",
    });
    assert.deepEqual(
      filtered.map((row) => row.slug),
      ["alpha-ticket", "child"],
    );
    assert.deepEqual(
      filterTicketsByMeta([alpha, beta], {
        workflow: "",
        stage: "done",
        priority: "high",
        resolution: "completed",
      }).map((row) => row.slug),
      ["alpha-ticket"],
    );
  });

  it("empty q sorts newest-first by stage_entered_at", () => {
    const ordered = orderTicketsForList([alpha, beta], "");
    assert.deepEqual(
      ordered.map((row) => row.slug),
      ["beta-ticket", "alpha-ticket"],
    );
  });

  it("non-empty q uses BM25 order, not newest-first", () => {
    const ordered = orderTicketsForList([alpha, beta], "search");
    assert.equal(ordered[0]?.slug, "alpha-ticket");
    assert.ok(ordered.some((row) => row.slug === "alpha-ticket"));
  });

  it("1–2 letter q yields 0 hits (TRA-83)", () => {
    assert.deepEqual(orderTicketsForList([alpha, beta], "ab"), []);
    assert.deepEqual(orderTicketsForList([alpha, beta], "x"), []);
  });

  it("paginates with a visible total past 25 (no silent 20/100 cap)", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      ticket({
        slug: `t-${i}`,
        title: `Ticket ${i}`,
        stage_entered_at: `2026-08-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      }),
    );
    const first = pageTicketList(many, parseTicketListQuery({}));
    assert.equal(first.total, 30);
    assert.equal(first.limit, TICKETS_PAGE_SIZE);
    assert.equal(first.items.length, 25);
    const second = pageTicketList(
      many,
      parseTicketListQuery({ offset: String(TICKETS_PAGE_SIZE) }),
    );
    assert.equal(second.total, 30);
    assert.equal(second.offset, 25);
    assert.equal(second.items.length, 5);
  });

  it("formats tokens and entered dates", () => {
    assert.equal(formatTokens(null, null), "—");
    assert.equal(formatTokens(18000, 12500), "18000 / 12500");
    assert.equal(formatTokens(18000, null), "18000 / —");
    assert.equal(formatEntered("2026-08-21T15:32:12.874Z"), "2026-08-21");
    assert.equal(formatEntered(null), "—");
  });

  it("uniqueStageKeys keeps first-seen order", () => {
    assert.deepEqual(uniqueStageKeys(["todo", "done", "todo", " review "]), [
      "todo",
      "done",
      "review",
    ]);
  });
});
