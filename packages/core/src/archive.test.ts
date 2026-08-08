import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STAGES,
  LAST_STAGE_VISIBLE_LIMIT,
  lastStageKey,
  newestFirstCapped,
} from "./types.js";

const at = (day: number) => new Date(Date.UTC(2026, 0, day)).toISOString();

describe("lastStageKey", () => {
  it("returns the last stage key from the workflow definition", () => {
    assert.equal(lastStageKey(DEFAULT_STAGES), "done");
  });

  it("works when the last stage is not named done", () => {
    assert.equal(
      lastStageKey([
        { key: "todo", name: "To do", transitions: ["shipped"] },
        { key: "shipped", name: "Shipped", transitions: [] },
      ]),
      "shipped",
    );
  });

  it("returns null for an empty stages list", () => {
    assert.equal(lastStageKey([]), null);
  });
});

describe("newestFirstCapped", () => {
  it("keeps only the newest tickets up to the limit", () => {
    const tickets = Array.from({ length: 25 }, (_, i) => ({
      slug: `t-${i}`,
      enteredAt: at(i + 1),
    }));
    const visible = newestFirstCapped(tickets, (t) => t.enteredAt, 20);
    assert.equal(visible.length, 20);
    assert.equal(visible[0]?.slug, "t-24");
    assert.equal(visible.at(-1)?.slug, "t-5");
  });

  it("returns everything when at or under the limit", () => {
    const tickets = Array.from({ length: LAST_STAGE_VISIBLE_LIMIT }, (_, i) => ({
      slug: `t-${i}`,
      enteredAt: at(i + 1),
    }));
    assert.equal(
      newestFirstCapped(tickets, (t) => t.enteredAt).length,
      LAST_STAGE_VISIBLE_LIMIT,
    );
  });

  it("sorts newest first regardless of input order", () => {
    const visible = newestFirstCapped(
      [
        { slug: "b", enteredAt: at(3) },
        { slug: "a", enteredAt: at(1) },
        { slug: "c", enteredAt: at(2) },
      ],
      (t) => t.enteredAt,
    );
    assert.deepEqual(
      visible.map((t) => t.slug),
      ["b", "c", "a"],
    );
  });

  it("treats a missing timestamp as oldest instead of dropping the ticket", () => {
    const visible = newestFirstCapped(
      [{ slug: "unknown" }, { slug: "known", enteredAt: at(1) }],
      (t) => (t as { enteredAt?: string }).enteredAt,
    );
    assert.deepEqual(
      visible.map((t) => t.slug),
      ["known", "unknown"],
    );
  });

  it("does not mutate the input array", () => {
    const tickets = [
      { slug: "a", enteredAt: at(1) },
      { slug: "b", enteredAt: at(2) },
    ];
    newestFirstCapped(tickets, (t) => t.enteredAt, 1);
    assert.deepEqual(
      tickets.map((t) => t.slug),
      ["a", "b"],
    );
  });
});
