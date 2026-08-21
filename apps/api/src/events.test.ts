import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TicketEventBus,
  TicketEventStore,
  ticketEventFromMapped,
  type TicketEvent,
} from "./events.js";

function sampleEvent(overrides: { project?: string; slug?: string } = {}): TicketEvent {
  return ticketEventFromMapped("ticket.created", {
    slug: overrides.slug ?? "example",
    title: "Example",
    stage: "todo",
    project: overrides.project ?? "traceai",
  });
}

describe("TicketEventStore", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "traceai-events-"));
    dbPath = join(dir, "events.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("assigns monotonic ids and replays from a cursor", () => {
    const store = new TicketEventStore(dbPath);
    const a = store.append(sampleEvent());
    const b = store.append(sampleEvent());
    const cRec = store.append(sampleEvent());

    assert.equal(a.event_id, 1);
    assert.equal(b.event_id, 2);
    assert.equal(cRec.event_id, 3);
    assert.equal(store.latestId(), 3);

    assert.deepEqual(
      store.readAfter(0).map((r) => r.event_id),
      [1, 2, 3],
    );
    assert.deepEqual(
      store.readAfter(2).map((r) => r.event_id),
      [3],
    );
    assert.deepEqual(store.readAfter(3), []);
    store.close();
  });

  it("filters replay by project", () => {
    const store = new TicketEventStore(dbPath);
    store.append(sampleEvent({ project: "traceai" }));
    store.append(sampleEvent({ project: "other" }));
    store.append(sampleEvent({ project: "traceai" }));

    const traceai = store.readAfter(0, { project: "traceai" });
    assert.deepEqual(
      traceai.map((r) => r.event_id),
      [1, 3],
    );
    assert.ok(traceai.every((r) => r.event.project === "traceai"));
    store.close();
  });

  it("survives an API process restart (events persist on disk)", () => {
    const first = new TicketEventStore(dbPath);
    first.append(sampleEvent());
    first.append(sampleEvent());
    first.close();

    const reopened = new TicketEventStore(dbPath);
    const replay = reopened.readAfter(0);
    assert.equal(replay.length, 2);
    assert.equal(reopened.latestId(), 2);
    reopened.close();
  });
});

describe("TicketEventBus", () => {
  it("persists on publish and notifies every subscriber", () => {
    const store = new TicketEventStore(":memory:");
    const bus = new TicketEventBus(store);

    let aHits = 0;
    let bHits = 0;
    bus.subscribe(() => {
      aHits += 1;
    });
    bus.subscribe(() => {
      bHits += 1;
    });
    assert.equal(bus.subscriberCount(), 2);

    const record = bus.publish(sampleEvent());
    assert.equal(record.event_id, 1);
    assert.equal(aHits, 1);
    assert.equal(bHits, 1);

    // A second (drained) subscriber can read the persisted event by id,
    // mirroring how the SSE handler replays from the store.
    assert.deepEqual(
      bus.getEventsAfter(0).map((r) => r.event_id),
      [1],
    );
    bus.close();
  });

  it("pump() surfaces events written directly to the shared store (cross-process)", () => {
    const store = new TicketEventStore(":memory:");
    const bus = new TicketEventBus(store);

    let notified = 0;
    bus.subscribe(() => {
      notified += 1;
    });

    // Simulate another API worker appending straight to the shared DB.
    store.append(sampleEvent());
    assert.equal(notified, 0);

    bus.pump();
    assert.equal(notified, 1);

    // Idempotent: no new rows → no extra notification.
    bus.pump();
    assert.equal(notified, 1);
    bus.close();
  });
});
