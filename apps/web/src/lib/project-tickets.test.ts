import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TICKETS_PAGE_SIZE,
  columnAriaSort,
  defaultDirForSort,
  filterTicketsByMeta,
  formatEntered,
  formatTokens,
  nextTicketListSort,
  orderTicketsForList,
  pageTicketList,
  parseTicketListQuery,
  sortTicketsByColumn,
  ticketListColumnHref,
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
        sort: "",
        dir: "",
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

const gamma = ticket({
  slug: "gamma-ticket",
  ticket_key: "TRA-10",
  title: "Zebra work",
  workflow: "bug",
  stage: "backlog",
  priority: "low",
  tokens_actual: 100,
  tokens_estimate: 500,
  stage_entered_at: "2026-08-10T10:00:00.000Z",
});

const noKey = ticket({
  slug: "no-key",
  title: "Missing key",
  ticket_key: null,
  priority: "high",
  tokens_actual: null,
  tokens_estimate: 50,
  stage_entered_at: null,
});

describe("TRA-97 ticket list column sort", () => {
  it("parses sort/dir and ignores invalid values", () => {
    assert.deepEqual(parseTicketListQuery({ sort: "title", dir: "desc" }).sort, "title");
    assert.equal(parseTicketListQuery({ sort: "title", dir: "desc" }).dir, "desc");
    assert.equal(parseTicketListQuery({ sort: "nope", dir: "asc" }).sort, "");
    assert.equal(parseTicketListQuery({ sort: "nope", dir: "asc" }).dir, "");
    assert.equal(parseTicketListQuery({ sort: "title", dir: "sideways" }).dir, "asc");
    assert.equal(parseTicketListQuery({ sort: "entered" }).dir, "desc");
    assert.equal(parseTicketListQuery({ dir: "desc" }).sort, "");
  });

  it("href includes sort+dir and omits them when unset", () => {
    const sorted = parseTicketListQuery({
      q: "search",
      sort: "title",
      dir: "asc",
      offset: "25",
    });
    assert.equal(
      ticketListHref("traceai", sorted),
      "/projects/traceai/tickets?q=search&sort=title&dir=asc&offset=25",
    );
    assert.equal(
      ticketListHref("traceai", parseTicketListQuery({})),
      "/projects/traceai/tickets",
    );
  });

  it("column href resets offset and toggles the active column", () => {
    const query = parseTicketListQuery({
      sort: "title",
      dir: "asc",
      offset: "25",
      q: "search",
    });
    assert.equal(
      ticketListColumnHref("traceai", query, "title"),
      "/projects/traceai/tickets?q=search&sort=title&dir=desc",
    );
    assert.equal(
      ticketListColumnHref("traceai", query, "entered"),
      "/projects/traceai/tickets?q=search&sort=entered&dir=desc",
    );
    assert.equal(defaultDirForSort("key"), "asc");
    assert.equal(defaultDirForSort("tokens"), "desc");
    assert.deepEqual(nextTicketListSort(query, "title"), {
      sort: "title",
      dir: "desc",
    });
    assert.equal(columnAriaSort(query, "title"), "ascending");
    assert.equal(columnAriaSort(query, "key"), "none");
  });

  it("sorts key numerically and puts missing keys last", () => {
    const ordered = sortTicketsByColumn([gamma, alpha, noKey], "key", "asc");
    assert.deepEqual(
      ordered.map((row) => row.slug),
      ["alpha-ticket", "gamma-ticket", "no-key"],
    );
  });

  it("sorts title case-insensitively", () => {
    const ordered = sortTicketsByColumn([gamma, alpha, beta], "title", "asc");
    assert.deepEqual(
      ordered.map((row) => row.slug),
      ["alpha-ticket", "beta-ticket", "gamma-ticket"],
    );
  });

  it("priority rank is high > medium > low, not alphabetical", () => {
    const desc = sortTicketsByColumn([gamma, alpha, beta], "priority", "desc");
    assert.deepEqual(
      desc.map((row) => row.slug),
      ["alpha-ticket", "beta-ticket", "gamma-ticket"],
    );
    const asc = sortTicketsByColumn([gamma, alpha, beta], "priority", "asc");
    assert.deepEqual(
      asc.map((row) => row.slug),
      ["gamma-ticket", "beta-ticket", "alpha-ticket"],
    );
  });

  it("tokens sorts by actual then estimate with nulls last in both directions", () => {
    const desc = sortTicketsByColumn([noKey, gamma, alpha], "tokens", "desc");
    assert.equal(desc[0]?.slug, "gamma-ticket");
    assert.equal(desc[desc.length - 1]?.slug, "alpha-ticket");
    const asc = sortTicketsByColumn([noKey, gamma, alpha], "tokens", "asc");
    assert.equal(asc[0]?.slug, "gamma-ticket");
    assert.equal(asc[asc.length - 1]?.slug, "alpha-ticket");
  });

  it("entered sorts timestamps and puts missing last", () => {
    const desc = sortTicketsByColumn([alpha, beta, noKey], "entered", "desc");
    assert.deepEqual(
      desc.map((row) => row.slug),
      ["beta-ticket", "alpha-ticket", "no-key"],
    );
  });

  it("q without sort keeps BM25 order", () => {
    const ordered = orderTicketsForList([alpha, beta], {
      q: "search",
      sort: "",
      dir: "",
    });
    assert.equal(ordered[0]?.slug, "alpha-ticket");
  });

  it("q + sort keeps BM25 membership but uses column order", () => {
    const withSearch = ticket({
      slug: "search-later",
      ticket_key: "TRA-9",
      title: "Later search hit",
      description: "Implement project search across tickets",
    });
    const ordered = orderTicketsForList([withSearch, alpha, beta], {
      q: "search",
      sort: "key",
      dir: "asc",
    });
    assert.deepEqual(
      ordered.map((row) => row.slug),
      ["alpha-ticket", "search-later"],
    );
  });

  it("paginates after column sort", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      ticket({
        slug: `t-${i}`,
        ticket_key: `TRA-${i}`,
        title: `Ticket ${i}`,
      }),
    );
    const page = pageTicketList(
      many,
      parseTicketListQuery({ sort: "key", dir: "desc" }),
    );
    assert.equal(page.total, 30);
    assert.equal(page.items[0]?.ticket_key, "TRA-29");
    assert.equal(page.items.length, TICKETS_PAGE_SIZE);
  });
});
