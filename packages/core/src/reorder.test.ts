import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertNonNegativeIntegerSortOrder,
  planTicketReorder,
} from "./reorder.js";

describe("assertNonNegativeIntegerSortOrder", () => {
  it("accepts non-negative integers", () => {
    assert.doesNotThrow(() => assertNonNegativeIntegerSortOrder(0));
    assert.doesNotThrow(() => assertNonNegativeIntegerSortOrder(12));
  });

  it("rejects negative or non-integer values", () => {
    assert.throws(
      () => assertNonNegativeIntegerSortOrder(-1),
      /sort_order must be a non-negative integer/,
    );
    assert.throws(
      () => assertNonNegativeIntegerSortOrder(1.5),
      /sort_order must be a non-negative integer/,
    );
  });
});

describe("planTicketReorder", () => {
  const tickets = [
    {
      slug: "a",
      project: "traceai",
      stage: "backlog",
      workflow: "wf-a",
      sort_order: 0,
    },
    {
      slug: "b",
      project: "traceai",
      stage: "backlog",
      workflow: "wf-a",
      sort_order: 1,
    },
    {
      slug: "c",
      project: "traceai",
      stage: "backlog",
      workflow: "wf-a",
      sort_order: 2,
    },
    {
      slug: "d",
      project: "traceai",
      stage: "todo",
      workflow: "wf-a",
      sort_order: 0,
    },
    {
      slug: "other",
      project: "traceai",
      stage: "backlog",
      workflow: "wf-b",
      sort_order: 0,
    },
  ];

  it("assigns sort_order by index and returns only changed tickets", () => {
    const updates = planTicketReorder({
      project: "traceai",
      stage: "backlog",
      workflow: "wf-a",
      ordered_slugs: ["c", "a", "b"],
      tickets,
    });
    assert.deepEqual(updates, [
      { slug: "c", sort_order: 0 },
      { slug: "a", sort_order: 1 },
      { slug: "b", sort_order: 2 },
    ]);
  });

  it("returns empty when order is already correct", () => {
    const updates = planTicketReorder({
      project: "traceai",
      stage: "backlog",
      workflow: "wf-a",
      ordered_slugs: ["a", "b", "c"],
      tickets,
    });
    assert.deepEqual(updates, []);
  });

  it("rejects a slug outside the stage", () => {
    assert.throws(
      () =>
        planTicketReorder({
          project: "traceai",
          stage: "backlog",
          workflow: "wf-a",
          ordered_slugs: ["a", "b", "d"],
          tickets,
        }),
      /not in project/,
    );
  });

  it("rejects incomplete ordered_slugs", () => {
    assert.throws(
      () =>
        planTicketReorder({
          project: "traceai",
          stage: "backlog",
          workflow: "wf-a",
          ordered_slugs: ["a", "b"],
          tickets,
        }),
      /must include every ticket/,
    );
  });

  it("rejects duplicates", () => {
    assert.throws(
      () =>
        planTicketReorder({
          project: "traceai",
          stage: "backlog",
          workflow: "wf-a",
          ordered_slugs: ["a", "a", "b"],
          tickets,
        }),
      /duplicates/,
    );
  });

  it("rejects a slug from another workflow with the same stage key", () => {
    assert.throws(
      () =>
        planTicketReorder({
          project: "traceai",
          stage: "backlog",
          workflow: "wf-a",
          ordered_slugs: ["a", "b", "c", "other"],
          tickets,
        }),
      /not in project/,
    );
  });

  it("does not require tickets from another workflow in ordered_slugs", () => {
    const updates = planTicketReorder({
      project: "traceai",
      stage: "backlog",
      workflow: "wf-a",
      ordered_slugs: ["a", "b", "c"],
      tickets,
    });
    assert.deepEqual(updates, []);
  });

  it("rejects a missing workflow", () => {
    assert.throws(
      () =>
        planTicketReorder({
          project: "traceai",
          stage: "backlog",
          workflow: "",
          ordered_slugs: ["a", "b", "c"],
          tickets,
        }),
      /workflow is required/,
    );
  });
});
