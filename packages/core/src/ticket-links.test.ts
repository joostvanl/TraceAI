import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeTokenRollup,
  listChildTickets,
  listDescendantSlugs,
  resolveTicketRef,
  validateTicketParent,
  type TicketLinkRow,
} from "./ticket-links.js";

function row(
  slug: string,
  opts: Partial<TicketLinkRow> & { project?: string } = {},
): TicketLinkRow {
  return {
    slug,
    project: opts.project ?? "traceai",
    ticket_key: opts.ticket_key ?? null,
    parent: opts.parent ?? null,
    tokens_estimate: opts.tokens_estimate ?? null,
    tokens_actual: opts.tokens_actual ?? null,
  };
}

describe("resolveTicketRef", () => {
  it("resolves by slug or ticket key", () => {
    const tickets = [
      row("parent-ticket", { ticket_key: "TRA-1" }),
      row("child-ticket", { ticket_key: "TRA-2", parent: "parent-ticket" }),
    ];
    assert.equal(resolveTicketRef(tickets, "parent-ticket")?.slug, "parent-ticket");
    assert.equal(resolveTicketRef(tickets, "TRA-1")?.slug, "parent-ticket");
    assert.equal(resolveTicketRef(tickets, "tra-2")?.slug, "child-ticket");
    assert.equal(resolveTicketRef(tickets, "missing"), null);
  });
});

describe("validateTicketParent", () => {
  const tickets = [
    row("root", { ticket_key: "TRA-1", tokens_estimate: 1000 }),
    row("mid", { ticket_key: "TRA-2", parent: "root", tokens_estimate: 2000 }),
    row("leaf", { ticket_key: "TRA-3", parent: "mid", tokens_estimate: 3000 }),
    row("other-project", { project: "other", ticket_key: "OTH-1" }),
  ];

  it("accepts a valid parent by key and returns canonical slug", () => {
    assert.equal(
      validateTicketParent({
        tickets,
        project: "traceai",
        selfSlug: "leaf",
        parentRef: "TRA-1",
      }),
      "root",
    );
  });

  it("clears parent when empty", () => {
    assert.equal(
      validateTicketParent({
        tickets,
        project: "traceai",
        selfSlug: "leaf",
        parentRef: "",
      }),
      null,
    );
  });

  it("rejects missing, cross-project, self, and cycles", () => {
    assert.throws(
      () =>
        validateTicketParent({
          tickets,
          project: "traceai",
          selfSlug: "leaf",
          parentRef: "nope",
        }),
      /not found/i,
    );
    assert.throws(
      () =>
        validateTicketParent({
          tickets,
          project: "traceai",
          selfSlug: "leaf",
          parentRef: "other-project",
        }),
      /different project/i,
    );
    assert.throws(
      () =>
        validateTicketParent({
          tickets,
          project: "traceai",
          selfSlug: "root",
          parentRef: "root",
        }),
      /own parent/i,
    );
    assert.throws(
      () =>
        validateTicketParent({
          tickets,
          project: "traceai",
          selfSlug: "root",
          parentRef: "leaf",
        }),
      /cycle/i,
    );
  });
});

describe("listChildTickets", () => {
  it("returns direct children only", () => {
    const tickets = [
      row("root"),
      row("a", { parent: "root" }),
      row("b", { parent: "root" }),
      row("c", { parent: "a" }),
    ];
    assert.deepEqual(
      listChildTickets(tickets, "root").map((t) => t.slug),
      ["a", "b"],
    );
  });
});

describe("listDescendantSlugs", () => {
  it("returns all nested descendants without the root", () => {
    const tickets = [
      row("root"),
      row("a", { parent: "root" }),
      row("b", { parent: "root" }),
      row("c", { parent: "a" }),
      row("d", { parent: "c" }),
    ];
    assert.deepEqual(listDescendantSlugs(tickets, "root").sort(), [
      "a",
      "b",
      "c",
      "d",
    ]);
    assert.deepEqual(listDescendantSlugs(tickets, "a").sort(), ["c", "d"]);
  });
});

describe("computeTokenRollup", () => {
  it("sums own + all descendants across nesting", () => {
    const tickets = [
      row("root", { tokens_estimate: 1000, tokens_actual: 100 }),
      row("mid", { parent: "root", tokens_estimate: 2000, tokens_actual: 200 }),
      row("leaf", { parent: "mid", tokens_estimate: 3000, tokens_actual: 300 }),
      row("sib", { parent: "root", tokens_estimate: 400 }),
    ];
    assert.deepEqual(computeTokenRollup(tickets, "root"), {
      tokens_estimate_rollup: 6400,
      tokens_actual_rollup: 600,
    });
    assert.deepEqual(computeTokenRollup(tickets, "mid"), {
      tokens_estimate_rollup: 5000,
      tokens_actual_rollup: 500,
    });
  });

  it("treats missing estimates as zero so parent can be pure sum of children", () => {
    const tickets = [
      row("root"),
      row("a", { parent: "root", tokens_estimate: 1500 }),
      row("b", { parent: "root", tokens_estimate: 500 }),
    ];
    assert.deepEqual(computeTokenRollup(tickets, "root"), {
      tokens_estimate_rollup: 2000,
      tokens_actual_rollup: 0,
    });
  });
});
