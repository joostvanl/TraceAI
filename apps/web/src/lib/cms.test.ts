import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ListEntriesQuery } from "@traceai/core";
import {
  listTicketsForProject,
  listWikiPagesForProject,
  listProjects,
  snapshotFromRow,
} from "./cms.js";

/**
 * TRA-75: these reads used to ask Aurora for 100 entries across every project
 * and filter in memory, so anything past entry 100 silently vanished from the
 * UI. The stub below enforces Aurora's real page cap so a regression shows up
 * as missing rows rather than as a passing test.
 */
const PAGE_SIZE = 100;

type Entry = { id: string; slug: string; fields: Record<string, unknown> };

function stubClient(entriesByType: Record<string, Entry[]>) {
  const calls: Array<{ apiId: string; query: ListEntriesQuery }> = [];
  return {
    calls,
    async listEntries<T>(apiId: string, query: ListEntriesQuery = {}) {
      calls.push({ apiId, query });
      let items = entriesByType[apiId] ?? [];
      // Mimic Aurora's server-side field/in filter on a slug-valued relation.
      if (query.field) {
        const wanted = new Set(
          (Array.isArray(query.in) ? query.in : [query.in ?? ""]).map(String),
        );
        items = items.filter((e) =>
          wanted.has(String(e.fields[query.field as string] ?? "")),
        );
      }
      const total = items.length;
      const offset = query.offset ?? 0;
      const limit = Math.min(query.limit ?? PAGE_SIZE, PAGE_SIZE);
      return {
        items: items.slice(offset, offset + limit) as T[],
        total,
        limit,
        offset,
      };
    },
  };
}

function ticket(n: number, project: string): Entry {
  return {
    id: `id-t-${n}`,
    slug: `ticket-${String(n).padStart(3, "0")}`,
    fields: {
      title: `Ticket ${n}`,
      project,
      ticket_key: `TRA-${n}`,
      stage: "backlog",
      sort_order: n,
    },
  };
}

function wikiPage(n: number, project: string, parent: string | null): Entry {
  return {
    id: `id-w-${n}`,
    slug: `page-${String(n).padStart(3, "0")}`,
    fields: {
      title: `Page ${n}`,
      project,
      parent,
      sort_order: n,
    },
  };
}

describe("listTicketsForProject (TRA-75)", () => {
  it("returns tickets past entry 100 when other projects fill the first page", () => {
    // 80 foreign tickets first, so 40 of the 60 wanted ones sit beyond page 1.
    const entries = [
      ...Array.from({ length: 80 }, (_, i) => ticket(i, "other-project")),
      ...Array.from({ length: 60 }, (_, i) => ticket(100 + i, "traceai")),
    ];
    const client = stubClient({ ticket: entries });
    return listTicketsForProject("traceai", client).then((tickets) => {
      assert.equal(tickets.length, 60);
      assert.ok(
        tickets.every((t) => t.fields.project === "traceai"),
        "must not leak other projects",
      );
    });
  });

  it("keeps sort_order ascending", async () => {
    const entries = [ticket(3, "traceai"), ticket(1, "traceai"), ticket(2, "traceai")];
    const client = stubClient({ ticket: entries });
    const tickets = await listTicketsForProject("traceai", client);
    assert.deepEqual(
      tickets.map((t) => t.fields.sort_order),
      [1, 2, 3],
    );
  });

  it("falls back to a full scan when the relation filter matches nothing", async () => {
    // Relation stored as an object: Aurora's field/in filter finds no rows.
    const entries = Array.from({ length: 120 }, (_, i) => ({
      ...ticket(i, "traceai"),
      fields: { ...ticket(i, "traceai").fields, project: { slug: "traceai" } },
    }));
    const client = stubClient({ ticket: entries });
    const tickets = await listTicketsForProject("traceai", client);
    assert.equal(tickets.length, 120, "fallback must still return every ticket");
    assert.ok(
      client.calls.some((c) => c.query.field === "project"),
      "should try the server-side filter before scanning",
    );
  });
});

describe("listWikiPagesForProject (TRA-75)", () => {
  it("returns every page of the project beyond the first Aurora page", async () => {
    const entries = [
      ...Array.from({ length: 70 }, (_, i) => wikiPage(i, "other", null)),
      ...Array.from({ length: 55 }, (_, i) => wikiPage(200 + i, "traceai", null)),
    ];
    const client = stubClient({ wiki_page: entries });
    const { pages, tree } = await listWikiPagesForProject("traceai", client);
    assert.equal(pages.length, 55);
    assert.equal(tree.length, 55, "all root pages appear in the tree");
  });

  it("nests children under their parent", async () => {
    const entries = [
      wikiPage(1, "traceai", null),
      wikiPage(2, "traceai", "page-001"),
      wikiPage(3, "traceai", "page-001"),
    ];
    const client = stubClient({ wiki_page: entries });
    const { tree } = await listWikiPagesForProject("traceai", client);
    assert.equal(tree.length, 1);
    assert.equal(tree[0]?.children.length, 2);
  });
});

describe("snapshotFromRow (TRA-112)", () => {
  it("includes claimed_agent_id on the board snapshot", () => {
    const claimed = snapshotFromRow(
      {
        slug: "claimed",
        ticket_key: "TRA-112",
        title: "Claimed",
        stage: "in_progress",
        workflow: "traceai-traceai-story",
        claimed_agent_id: "bc-abcdefghijklmno",
      },
      "traceai-traceai-story",
    );
    assert.equal(claimed.claimedAgentId, "bc-abcdefghijklmno");

    const unclaimed = snapshotFromRow(
      {
        slug: "open",
        ticket_key: "TRA-1",
        title: "Open",
        stage: "todo",
        workflow: "traceai-traceai-story",
      },
      "traceai-traceai-story",
    );
    assert.equal(unclaimed.claimedAgentId, null);
  });

  it("treats blank claimed_agent_id as unclaimed", () => {
    const snap = snapshotFromRow(
      {
        slug: "blank",
        title: "Blank",
        stage: "todo",
        claimed_agent_id: "  ",
      },
      "wf",
    );
    assert.equal(snap.claimedAgentId, null);
  });
});

describe("listProjects (TRA-75)", () => {
  it("returns more than one Aurora page of projects", async () => {
    const entries = Array.from({ length: 150 }, (_, i) => ({
      id: `id-p-${i}`,
      slug: `project-${i}`,
      fields: { name: `Project ${i}` },
    }));
    const client = stubClient({ project: entries });
    const projects = await listProjects(client);
    assert.equal(projects.length, 150);
  });
});
