import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AGENT_BUSY_RETRY_MS,
  AGENT_BUSY_RETRY_WINDOW_MS,
  type CursorCloudFollowUp,
  type Ticket,
} from "@traceai/core";
import {
  NudgeQueueStore,
  enqueueBusyCloudNudgeForVerdict,
  processDueCloudNudges,
} from "./nudge-queue.js";

function ticket(overrides: Partial<Ticket["fields"]> & { slug?: string } = {}): Ticket {
  const { slug, ...fields } = overrides;
  return {
    id: "1",
    slug: slug ?? "sample",
    contentType: "ticket",
    status: "published",
    locale: "en-US",
    publishedAt: null,
    createdAt: "",
    updatedAt: "",
    fields: {
      title: "Sample",
      project: "traceai",
      workflow: "wf",
      stage: "todo",
      ticket_key: "TRA-1",
      claimed_agent_id: "bc-cloud-1",
      ...fields,
    },
  };
}

function busyResult(overrides: { agentId?: string; prompt?: string } = {}) {
  return {
    attempted: true as const,
    calls: 1,
    busy: true as const,
    status: 409,
    agentId: overrides.agentId ?? "bc-cloud-1",
    prompt: overrides.prompt ?? "prompt-a",
  };
}

describe("NudgeQueueStore", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "traceai-nudge-"));
    dbPath = join(dir, "nudge.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps one row per ticket slug and replaces on a newer verdict", () => {
    const store = new NudgeQueueStore(":memory:");
    const t = new Date("2026-08-26T00:00:00.000Z");
    enqueueBusyCloudNudgeForVerdict(
      store,
      ticket(),
      "approved",
      busyResult({ prompt: "first" }),
      t,
    );
    enqueueBusyCloudNudgeForVerdict(
      store,
      ticket(),
      "rejected",
      busyResult({ prompt: "second" }),
      t,
    );
    const rows = store.listAll();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.verdict, "rejected");
    assert.equal(rows[0]?.prompt, "second");
    store.close();
  });

  it("keeps separate rows for two tickets with the same orchestrator", () => {
    const store = new NudgeQueueStore(":memory:");
    const t = new Date("2026-08-26T00:00:00.000Z");
    enqueueBusyCloudNudgeForVerdict(
      store,
      ticket({ slug: "ticket-a" }),
      "approved",
      busyResult(),
      t,
    );
    enqueueBusyCloudNudgeForVerdict(
      store,
      ticket({ slug: "ticket-b", ticket_key: "TRA-2" }),
      "approved",
      busyResult(),
      t,
    );
    assert.equal(store.listAll().length, 2);
    store.close();
  });

  it("leases a due row so a second worker does not take it", () => {
    const store = new NudgeQueueStore(":memory:");
    const t0 = new Date("2026-08-26T00:00:00.000Z");
    enqueueBusyCloudNudgeForVerdict(store, ticket(), "approved", busyResult(), t0);
    const due = new Date(t0.getTime() + AGENT_BUSY_RETRY_MS);
    const first = store.leaseDue(due, { leaseMs: 25_000 });
    const second = store.leaseDue(due, { leaseMs: 25_000 });
    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
    store.close();
  });

  it("re-leases after the lease expires", () => {
    const store = new NudgeQueueStore(":memory:");
    const t0 = new Date("2026-08-26T00:00:00.000Z");
    enqueueBusyCloudNudgeForVerdict(store, ticket(), "approved", busyResult(), t0);
    const due = new Date(t0.getTime() + AGENT_BUSY_RETRY_MS);
    assert.equal(store.leaseDue(due, { leaseMs: 25_000 }).length, 1);
    const later = new Date(due.getTime() + 26_000);
    assert.equal(store.leaseDue(later, { leaseMs: 25_000 }).length, 1);
    store.close();
  });

  it("survives process restart (rows persist on disk)", () => {
    const first = new NudgeQueueStore(dbPath);
    const t0 = new Date("2026-08-26T00:00:00.000Z");
    enqueueBusyCloudNudgeForVerdict(first, ticket(), "approved", busyResult(), t0);
    first.close();

    const reopened = new NudgeQueueStore(dbPath);
    const rows = reopened.listAll();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.ticket_slug, "sample");
    reopened.close();
  });

  it("stores the reviewing user's AuthStore id for busy retries", () => {
    const store = new NudgeQueueStore(":memory:");
    const t = new Date("2026-08-26T00:00:00.000Z");
    enqueueBusyCloudNudgeForVerdict(
      store,
      ticket(),
      "approved",
      busyResult(),
      t,
      "usr_reviewer",
    );
    assert.equal(store.listAll()[0]?.key_user_id, "usr_reviewer");
    store.close();
  });

  it("adds key_user_id on an existing queue database that predates the column", () => {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE pending_cloud_nudges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_slug TEXT UNIQUE NOT NULL,
        agent_id TEXT NOT NULL,
        verdict TEXT NOT NULL,
        stage TEXT NOT NULL,
        ticket_key TEXT,
        prompt TEXT NOT NULL,
        first_attempt_at TEXT NOT NULL,
        next_retry_at TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        lease_until TEXT,
        last_status INTEGER
      );
    `);
    db.close();

    const store = new NudgeQueueStore(dbPath);
    const t = new Date("2026-08-26T00:00:00.000Z");
    enqueueBusyCloudNudgeForVerdict(
      store,
      ticket(),
      "approved",
      busyResult(),
      t,
      "usr_migrated",
    );
    assert.equal(store.listAll()[0]?.key_user_id, "usr_migrated");
    store.close();
  });
});

describe("processDueCloudNudges", () => {
  function worker(options: {
    store: NudgeQueueStore;
    client: CursorCloudFollowUp | null;
    live?: Ticket | null | ((slug: string) => Ticket | null);
    comments?: Array<{ ticket: string; body: string }>;
    logs?: string[];
    now: Date;
  }) {
    const comments = options.comments ?? [];
    return {
      comments,
      deps: {
        store: options.store,
        getClient: () => options.client,
        loadTicket: async (slug: string) => {
          if (typeof options.live === "function") return options.live(slug);
          return options.live === undefined ? ticket({ slug }) : options.live;
        },
        addComment: async (input: { ticket: string; body: string }) => {
          comments.push(input);
        },
        now: () => options.now,
        log: (message: string) => {
          options.logs?.push(message);
        },
      },
    };
  }

  it("delivers a queued follow-up to the current bc- id once Cursor is not busy", async () => {
    const store = new NudgeQueueStore(":memory:");
    const t0 = new Date("2026-08-26T00:00:00.000Z");
    enqueueBusyCloudNudgeForVerdict(store, ticket(), "approved", busyResult(), t0);
    const calls: string[] = [];
    const { deps } = worker({
      store,
      now: new Date(t0.getTime() + AGENT_BUSY_RETRY_MS),
      client: {
        followUp: async (id) => {
          calls.push(id);
          return { ok: true, status: 201, busy: false };
        },
      },
    });
    await processDueCloudNudges(deps);
    assert.deepEqual(calls, ["bc-cloud-1"]);
    assert.equal(store.listAll().length, 0);
    store.close();
  });

  it("targets an overwritten current bc- claim (TRA-107 last-writer-wins)", async () => {
    const store = new NudgeQueueStore(":memory:");
    const t0 = new Date("2026-08-26T00:00:00.000Z");
    enqueueBusyCloudNudgeForVerdict(store, ticket(), "approved", busyResult(), t0);
    const calls: string[] = [];
    const { deps } = worker({
      store,
      now: new Date(t0.getTime() + AGENT_BUSY_RETRY_MS),
      live: ticket({ claimed_agent_id: "bc-new" }),
      client: {
        followUp: async (id) => {
          calls.push(id);
          return { ok: true, status: 201, busy: false };
        },
      },
    });
    await processDueCloudNudges(deps);
    assert.deepEqual(calls, ["bc-new"]);
    store.close();
  });

  it("retries while busy until a later tick succeeds", async () => {
    const store = new NudgeQueueStore(":memory:");
    const t0 = new Date("2026-08-26T00:00:00.000Z");
    enqueueBusyCloudNudgeForVerdict(store, ticket(), "approved", busyResult(), t0);
    let n = 0;
    const client: CursorCloudFollowUp = {
      followUp: async () => {
        n += 1;
        if (n === 1) return { ok: false, status: 409, busy: true };
        return { ok: true, status: 201, busy: false };
      },
    };
    const firstDue = new Date(t0.getTime() + AGENT_BUSY_RETRY_MS);
    await processDueCloudNudges(
      worker({ store, client, now: firstDue }).deps,
    );
    assert.equal(n, 1);
    assert.equal(store.listAll().length, 1);
    const secondDue = new Date(firstDue.getTime() + 60_000);
    await processDueCloudNudges(
      worker({ store, client, now: secondDue }).deps,
    );
    assert.equal(n, 2);
    assert.equal(store.listAll().length, 0);
    store.close();
  });

  it("skips with warn + ticket comment when the 30-minute window elapses", async () => {
    const store = new NudgeQueueStore(":memory:");
    const t0 = new Date("2026-08-26T00:00:00.000Z");
    enqueueBusyCloudNudgeForVerdict(store, ticket(), "approved", busyResult(), t0);
    const comments: Array<{ ticket: string; body: string }> = [];
    const logs: string[] = [];
    const calls: string[] = [];
    const { deps } = worker({
      store,
      comments,
      logs,
      now: new Date(t0.getTime() + AGENT_BUSY_RETRY_WINDOW_MS),
      client: {
        followUp: async (id) => {
          calls.push(id);
          return { ok: true, status: 201, busy: false };
        },
      },
    });
    await processDueCloudNudges(deps);
    assert.equal(calls.length, 0);
    assert.equal(store.listAll().length, 0);
    assert.equal(comments.length, 1);
    assert.match(comments[0]?.body ?? "", /TRA-1/);
    assert.match(comments[0]?.body ?? "", /bc-cloud-1/);
    assert.match(comments[0]?.body ?? "", /agent_busy/);
    assert.match(logs.join("\n"), /skipped/);
    store.close();
  });

  it("skips with comment on a non-busy Cursor error after enqueue", async () => {
    const store = new NudgeQueueStore(":memory:");
    const t0 = new Date("2026-08-26T00:00:00.000Z");
    enqueueBusyCloudNudgeForVerdict(store, ticket(), "approved", busyResult(), t0);
    const comments: Array<{ ticket: string; body: string }> = [];
    const { deps } = worker({
      store,
      comments,
      now: new Date(t0.getTime() + AGENT_BUSY_RETRY_MS),
      client: {
        followUp: async () => ({ ok: false, status: 500, busy: false }),
      },
    });
    await processDueCloudNudges(deps);
    assert.equal(store.listAll().length, 0);
    assert.equal(comments.length, 1);
    assert.match(comments[0]?.body ?? "", /non-busy Cursor error 500/);
    store.close();
  });

  it("drops the row without POST or skip comment when the claim is cleared", async () => {
    const store = new NudgeQueueStore(":memory:");
    const t0 = new Date("2026-08-26T00:00:00.000Z");
    enqueueBusyCloudNudgeForVerdict(store, ticket(), "approved", busyResult(), t0);
    const comments: Array<{ ticket: string; body: string }> = [];
    const calls: string[] = [];
    const { deps } = worker({
      store,
      comments,
      live: ticket({ claimed_agent_id: "" }),
      now: new Date(t0.getTime() + AGENT_BUSY_RETRY_MS),
      client: {
        followUp: async (id) => {
          calls.push(id);
          return { ok: true, status: 201, busy: false };
        },
      },
    });
    await processDueCloudNudges(deps);
    assert.equal(calls.length, 0);
    assert.equal(comments.length, 0);
    assert.equal(store.listAll().length, 0);
    store.close();
  });

  it("drops the row without POST or skip comment when the claim is non-bc-", async () => {
    const store = new NudgeQueueStore(":memory:");
    const t0 = new Date("2026-08-26T00:00:00.000Z");
    enqueueBusyCloudNudgeForVerdict(store, ticket(), "approved", busyResult(), t0);
    const comments: Array<{ ticket: string; body: string }> = [];
    const calls: string[] = [];
    const { deps } = worker({
      store,
      comments,
      live: ticket({ claimed_agent_id: "agent-local" }),
      now: new Date(t0.getTime() + AGENT_BUSY_RETRY_MS),
      client: {
        followUp: async (id) => {
          calls.push(id);
          return { ok: true, status: 201, busy: false };
        },
      },
    });
    await processDueCloudNudges(deps);
    assert.equal(calls.length, 0);
    assert.equal(comments.length, 0);
    store.close();
  });

  it("passes the stored key_user_id to getClient on retry", async () => {
    const store = new NudgeQueueStore(":memory:");
    const t0 = new Date("2026-08-26T00:00:00.000Z");
    enqueueBusyCloudNudgeForVerdict(
      store,
      ticket({ claimed_by_user_id: "" }),
      "approved",
      busyResult(),
      t0,
      "usr_reviewer",
    );
    const seen: Array<string | null | undefined> = [];
    const calls: string[] = [];
    await processDueCloudNudges({
      store,
      getClient: (_ticket, fallbackUserId) => {
        seen.push(fallbackUserId);
        return {
          followUp: async (id) => {
            calls.push(id);
            return { ok: true, status: 201, busy: false };
          },
        };
      },
      loadTicket: async () => ticket({ claimed_by_user_id: "" }),
      addComment: async () => {},
      now: () => new Date(t0.getTime() + AGENT_BUSY_RETRY_MS),
      log: () => {},
    });
    assert.deepEqual(seen, ["usr_reviewer"]);
    assert.deepEqual(calls, ["bc-cloud-1"]);
    store.close();
  });

  it("does not throw when skip-comment write fails", async () => {
    const store = new NudgeQueueStore(":memory:");
    const t0 = new Date("2026-08-26T00:00:00.000Z");
    enqueueBusyCloudNudgeForVerdict(store, ticket(), "approved", busyResult(), t0);
    await processDueCloudNudges({
      store,
      getClient: () => ({
        followUp: async () => ({ ok: false, status: 500, busy: false }),
      }),
      loadTicket: async () => ticket(),
      addComment: async () => {
        throw new Error("aurora down");
      },
      now: () => new Date(t0.getTime() + AGENT_BUSY_RETRY_MS),
      log: () => {},
    });
    assert.equal(store.listAll().length, 0);
    store.close();
  });

  it("delivers a persisted row after the store is reopened (API restart)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-nudge-restart-"));
    const dbPath = join(dir, "nudge.sqlite");
    try {
      const t0 = new Date("2026-08-26T00:00:00.000Z");
      const first = new NudgeQueueStore(dbPath);
      enqueueBusyCloudNudgeForVerdict(first, ticket(), "approved", busyResult(), t0);
      first.close();

      const reopened = new NudgeQueueStore(dbPath);
      const calls: string[] = [];
      await processDueCloudNudges(
        worker({
          store: reopened,
          now: new Date(t0.getTime() + AGENT_BUSY_RETRY_MS),
          client: {
            followUp: async (id) => {
              calls.push(id);
              return { ok: true, status: 201, busy: false };
            },
          },
        }).deps,
      );
      assert.deepEqual(calls, ["bc-cloud-1"]);
      assert.equal(reopened.listAll().length, 0);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
