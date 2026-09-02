import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTIVITY_MAX_CHARS,
  TicketActivityStore,
} from "./ticket-activity.js";

describe("TicketActivityStore", () => {
  it("overwrites the previous rule (last-write-wins)", () => {
    let now = new Date("2026-09-02T20:00:00.000Z");
    const store = new TicketActivityStore(":memory:", () => now);
    store.set("t1", "traceai", "nadenken");
    const second = store.set("t1", "traceai", "wiki doorlezen");
    assert.equal(second?.text, "wiki doorlezen");
    const rows = store.getMany("traceai");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.text, "wiki doorlezen");
  });

  it("clears on empty / whitespace text", () => {
    const store = new TicketActivityStore(":memory:");
    store.set("t1", "traceai", "nadenken");
    assert.equal(store.set("t1", "traceai", "   "), null);
    assert.equal(store.getMany("traceai").length, 0);
  });

  it("hides expired rows from getMany", () => {
    let now = new Date("2026-09-02T20:00:00.000Z");
    const store = new TicketActivityStore(":memory:", () => now);
    store.set("t1", "traceai", "nadenken");
    now = new Date("2026-09-02T20:03:00.000Z");
    assert.equal(store.getMany("traceai").length, 0);
  });

  it("does not leak another project's rows", () => {
    const store = new TicketActivityStore(":memory:");
    store.set("t1", "traceai", "nadenken");
    store.set("t2", "other", "code");
    assert.equal(store.getMany("traceai").length, 1);
    assert.equal(store.getMany("other")[0]?.ticket_slug, "t2");
  });

  it("documents the 80-char cap as a route concern, not silent truncate", () => {
    const store = new TicketActivityStore(":memory:");
    const long = "x".repeat(ACTIVITY_MAX_CHARS);
    const row = store.set("t1", "traceai", long);
    assert.equal(row?.text.length, ACTIVITY_MAX_CHARS);
  });
});
