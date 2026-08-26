import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, DEFAULT_AGENT_SCOPES } from "@traceai/auth";
import { createApp } from "./app.js";
import { configureNotificationStore } from "./notifications.js";
import { projectMemberStubs } from "./test-support.js";
import {
  NudgeQueueStore,
  processDueCloudNudges,
} from "./nudge-queue.js";
import { AGENT_BUSY_RETRY_MS } from "@traceai/core";

const PROXY_SECRET = "claim-wakeup-proxy";

function ticketEntry(overrides: Record<string, unknown> = {}) {
  const slug = (overrides.slug as string) ?? "sample-ticket";
  return {
    id: `id-${slug}`,
    slug,
    fields: {
      slug,
      ticket_key: "TRA-1",
      ticket_number: 1,
      title: "Sample",
      description: "desc",
      project: "traceai",
      workflow: "traceai-default",
      stage: "todo",
      priority: "medium",
      created_by: "agent",
      stage_entered_at: null,
      tokens_estimate: null,
      tokens_actual: null,
      resolution: null,
      review_state: null,
      review_by: null,
      review_at: null,
      parent: null,
      sort_order: 0,
      claimed_agent_id: "",
      ...overrides,
    },
  };
}

function wrappedTicket(overrides: Record<string, unknown> = {}) {
  const ticket = ticketEntry(overrides);
  return {
    ticket,
    comments: [],
    children: [],
    tokens_estimate_rollup: 0,
    tokens_actual_rollup: 0,
    parent_ticket: null,
  };
}

function authHeaders(token: string, extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

describe("claim + cloud wake-up (TRA-107)", () => {
  const prevProxy = process.env.TRACEAI_HUMAN_PROXY_SECRET;

  before(() => {
    process.env.TRACEAI_HUMAN_PROXY_SECRET = PROXY_SECRET;
    configureNotificationStore(":memory:");
  });

  after(() => {
    if (prevProxy === undefined) delete process.env.TRACEAI_HUMAN_PROXY_SECRET;
    else process.env.TRACEAI_HUMAN_PROXY_SECRET = prevProxy;
  });

  async function withClaimApp(
    serviceExtra: Record<string, unknown>,
    extras: {
      cursorCloud?: {
        followUp: (id: string, prompt: string) => Promise<{
          ok: boolean;
          status: number;
          busy: boolean;
        }>;
      } | null;
    },
    fn: (app: ReturnType<typeof createApp>, token: string) => Promise<void>,
  ) {
    const dir = mkdtempSync(join(tmpdir(), "traceai-claim-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    const jobs: Array<() => void> = [];
    try {
      const user = store.createUser({ email: "c@example.com", name: "C" });
      const token = store.createToken({
        userId: user.id,
        name: "agent",
        scopes: [...DEFAULT_AGENT_SCOPES],
      });
      const app = createApp({
        authStore: store,
        service: {
          ...projectMemberStubs({
            email: "c@example.com",
            projects: ["traceai"],
          }),
          listProjects: async () => [
            { slug: "traceai", fields: { name: "TraceAI" } },
          ],
          listTickets: async () => [],
          listReviewInbox: async () => [],
          ...serviceExtra,
        } as never,
        cursorCloud: extras.cursorCloud,
        scheduleWakeup: (fn) => jobs.push(fn),
      });
      await fn(app, token.token);
      for (const job of jobs) job();
      await new Promise((r) => setImmediate(r));
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("stores claimed_agent_id and derived kind", async () => {
    let stored = "";
    await withClaimApp(
      {
        getTicket: async () => wrappedTicket({ slug: "claim-me" }),
        claimTicket: async (_slug: string, agentId: string) => {
          stored = agentId;
          return ticketEntry({
            slug: "claim-me",
            claimed_agent_id: agentId,
          });
        },
      },
      { cursorCloud: null },
      async (app, token) => {
        const res = await app.request("/v1/tickets/claim-me/claim", {
          method: "POST",
          headers: authHeaders(token),
          body: JSON.stringify({ agent_id: "bc-abc-1" }),
        });
        assert.equal(res.status, 200, await res.clone().text());
        const body = (await res.json()) as {
          claimed_agent_id?: string;
          claimed_agent_kind?: string;
        };
        assert.equal(stored, "bc-abc-1");
        assert.equal(body.claimed_agent_id, "bc-abc-1");
        assert.equal(body.claimed_agent_kind, "cursor_cloud");
      },
    );
  });

  it("empty agent_id clears the claim", async () => {
    await withClaimApp(
      {
        getTicket: async () =>
          wrappedTicket({ slug: "claim-me", claimed_agent_id: "bc-old" }),
        claimTicket: async (_slug: string, agentId: string) =>
          ticketEntry({ slug: "claim-me", claimed_agent_id: agentId }),
      },
      { cursorCloud: null },
      async (app, token) => {
        const res = await app.request("/v1/tickets/claim-me/claim", {
          method: "POST",
          headers: authHeaders(token),
          body: JSON.stringify({ agent_id: "" }),
        });
        assert.equal(res.status, 200, await res.clone().text());
        const body = (await res.json()) as {
          claimed_agent_id?: string | null;
          claimed_agent_kind?: string | null;
        };
        assert.equal(body.claimed_agent_id, null);
        assert.equal(body.claimed_agent_kind, null);
      },
    );
  });

  it("nudges the current bc- claim after a verdict, not the previous owner", async () => {
    const calls: string[] = [];
    await withClaimApp(
      {
        getTicket: async () =>
          wrappedTicket({
            slug: "gated",
            stage: "todo",
            claimed_agent_id: "bc-new",
          }),
        recordReviewVerdict: async () => ({
          ticket: ticketEntry({
            slug: "gated",
            stage: "todo",
            claimed_agent_id: "bc-new",
            review_state: "approved",
          }),
          cascaded: [],
        }),
      },
      {
        cursorCloud: {
          followUp: async (id) => {
            calls.push(id);
            return { ok: true, status: 201, busy: false };
          },
        },
      },
      async (app, token) => {
        const res = await app.request("/v1/tickets/gated/review", {
          method: "POST",
          headers: authHeaders(token, {
            "x-traceai-human-proxy": PROXY_SECRET,
          }),
          body: JSON.stringify({ verdict: "approved" }),
        });
        assert.equal(res.status, 200, await res.text());
      },
    );
    assert.deepEqual(calls, ["bc-new"]);
  });

  it("does not call Cursor for a non-bc claim", async () => {
    const calls: string[] = [];
    await withClaimApp(
      {
        getTicket: async () =>
          wrappedTicket({
            slug: "gated",
            claimed_agent_id: "agent-local",
          }),
        recordReviewVerdict: async () => ({
          ticket: ticketEntry({
            slug: "gated",
            claimed_agent_id: "agent-local",
            review_state: "rejected",
          }),
          cascaded: [],
        }),
      },
      {
        cursorCloud: {
          followUp: async (id) => {
            calls.push(id);
            return { ok: true, status: 201, busy: false };
          },
        },
      },
      async (app, token) => {
        const res = await app.request("/v1/tickets/gated/review", {
          method: "POST",
          headers: authHeaders(token, {
            "x-traceai-human-proxy": PROXY_SECRET,
          }),
          body: JSON.stringify({ verdict: "rejected" }),
        });
        assert.equal(res.status, 200, await res.text());
      },
    );
    assert.equal(calls.length, 0);
  });

  it("review still 200 when Cursor is missing", async () => {
    await withClaimApp(
      {
        getTicket: async () =>
          wrappedTicket({
            slug: "gated",
            claimed_agent_id: "bc-abc",
          }),
        recordReviewVerdict: async () => ({
          ticket: ticketEntry({
            slug: "gated",
            claimed_agent_id: "bc-abc",
            review_state: "dismissed",
          }),
          cascaded: [],
        }),
      },
      { cursorCloud: null },
      async (app, token) => {
        const res = await app.request("/v1/tickets/gated/review", {
          method: "POST",
          headers: authHeaders(token, {
            "x-traceai-human-proxy": PROXY_SECRET,
          }),
          body: JSON.stringify({ verdict: "dismissed" }),
        });
        assert.equal(res.status, 200, await res.text());
      },
    );
  });

  it("review returns 200 before the wake-up job runs", async () => {
    const calls: string[] = [];
    await withClaimApp(
      {
        getTicket: async () =>
          wrappedTicket({ slug: "gated", claimed_agent_id: "bc-abc" }),
        recordReviewVerdict: async () => ({
          ticket: ticketEntry({
            slug: "gated",
            claimed_agent_id: "bc-abc",
            review_state: "approved",
          }),
          cascaded: [],
        }),
      },
      {
        cursorCloud: {
          followUp: async (id) => {
            calls.push(id);
            return { ok: true, status: 201, busy: false };
          },
        },
      },
      async (app, token) => {
        const res = await app.request("/v1/tickets/gated/review", {
          method: "POST",
          headers: authHeaders(token, {
            "x-traceai-human-proxy": PROXY_SECRET,
          }),
          body: JSON.stringify({ verdict: "approved" }),
        });
        assert.equal(res.status, 200, await res.text());
        assert.equal(calls.length, 0, "HTTP thread must not await the nudge");
      },
    );
    assert.deepEqual(calls, ["bc-abc"]);
  });

  it("review still 200 when Cursor returns 500", async () => {
    await withClaimApp(
      {
        getTicket: async () =>
          wrappedTicket({ slug: "gated", claimed_agent_id: "bc-abc" }),
        recordReviewVerdict: async () => ({
          ticket: ticketEntry({
            slug: "gated",
            claimed_agent_id: "bc-abc",
            review_state: "approved",
          }),
          cascaded: [],
        }),
      },
      {
        cursorCloud: {
          followUp: async () => ({ ok: false, status: 500, busy: false }),
        },
      },
      async (app, token) => {
        const res = await app.request("/v1/tickets/gated/review", {
          method: "POST",
          headers: authHeaders(token, {
            "x-traceai-human-proxy": PROXY_SECRET,
          }),
          body: JSON.stringify({ verdict: "approved" }),
        });
        assert.equal(res.status, 200, await res.text());
      },
    );
  });

  it("sends the locked prompt for approved, rejected, and dismissed", async () => {
    for (const verdict of ["approved", "rejected", "dismissed"] as const) {
      const prompts: string[] = [];
      await withClaimApp(
        {
          getTicket: async () =>
            wrappedTicket({
              slug: "gated",
              stage: "todo",
              claimed_agent_id: "bc-abc",
            }),
          recordReviewVerdict: async () => ({
            ticket: ticketEntry({
              slug: "gated",
              stage: "todo",
              claimed_agent_id: "bc-abc",
              review_state: verdict,
            }),
            cascaded: [],
          }),
        },
        {
          cursorCloud: {
            followUp: async (_id, prompt) => {
              prompts.push(prompt);
              return { ok: true, status: 201, busy: false };
            },
          },
        },
        async (app, token) => {
          const res = await app.request("/v1/tickets/gated/review", {
            method: "POST",
            headers: authHeaders(token, {
              "x-traceai-human-proxy": PROXY_SECRET,
            }),
            body: JSON.stringify({ verdict }),
          });
          assert.equal(res.status, 200, await res.text());
        },
      );
      assert.equal(prompts.length, 1, verdict);
      assert.match(prompts[0] ?? "", /expected_stage=todo/);
      assert.match(
        prompts[0] ?? "",
        new RegExp(`expected_review_state=${verdict}`),
      );
    }
  });

  it("nudges a cascaded child with its own bc- claim only", async () => {
    const calls: string[] = [];
    await withClaimApp(
      {
        getTicket: async () =>
          wrappedTicket({ slug: "parent", claimed_agent_id: "bc-parent" }),
        recordReviewVerdict: async () => ({
          ticket: ticketEntry({
            slug: "parent",
            claimed_agent_id: "bc-parent",
            review_state: "approved",
          }),
          cascaded: [
            ticketEntry({
              slug: "child-claimed",
              claimed_agent_id: "bc-child",
            }),
            ticketEntry({
              slug: "child-bare",
              claimed_agent_id: "",
            }),
          ],
        }),
      },
      {
        cursorCloud: {
          followUp: async (id) => {
            calls.push(id);
            return { ok: true, status: 201, busy: false };
          },
        },
      },
      async (app, token) => {
        const res = await app.request("/v1/tickets/parent/review", {
          method: "POST",
          headers: authHeaders(token, {
            "x-traceai-human-proxy": PROXY_SECRET,
          }),
          body: JSON.stringify({
            verdict: "approved",
            apply_to_children: true,
          }),
        });
        assert.equal(res.status, 200, await res.text());
      },
    );
    assert.deepEqual(calls.sort(), ["bc-child", "bc-parent"]);
  });
});

describe("durable busy-queue (TRA-113)", () => {
  const prevProxy = process.env.TRACEAI_HUMAN_PROXY_SECRET;

  before(() => {
    process.env.TRACEAI_HUMAN_PROXY_SECRET = PROXY_SECRET;
    configureNotificationStore(":memory:");
  });

  after(() => {
    if (prevProxy === undefined) delete process.env.TRACEAI_HUMAN_PROXY_SECRET;
    else process.env.TRACEAI_HUMAN_PROXY_SECRET = prevProxy;
  });

  async function withQueueApp(
    extras: {
      claimed?: string;
      followUp: (id: string, prompt: string) => Promise<{
        ok: boolean;
        status: number;
        busy: boolean;
      }>;
      getTicketOverride?: () => ReturnType<typeof wrappedTicket>;
      addComment?: (input: { ticket: string; body: string }) => Promise<void>;
      now: () => Date;
    },
    fn: (ctx: {
      app: ReturnType<typeof createApp>;
      token: string;
      queue: NudgeQueueStore;
      jobs: Array<() => void>;
    }) => Promise<void>,
  ) {
    const dir = mkdtempSync(join(tmpdir(), "traceai-nudge-http-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    const queue = new NudgeQueueStore(":memory:");
    const jobs: Array<() => void> = [];
    const claimed = extras.claimed ?? "bc-cloud-1";
    try {
      const user = store.createUser({ email: "c@example.com", name: "C" });
      const token = store.createToken({
        userId: user.id,
        name: "agent",
        scopes: [...DEFAULT_AGENT_SCOPES],
      });
      const liveTicket = () =>
        extras.getTicketOverride?.() ??
        wrappedTicket({
          slug: "gated",
          stage: "todo",
          claimed_agent_id: claimed,
          review_state: "approved",
        });
      const app = createApp({
        authStore: store,
        service: {
          ...projectMemberStubs({
            email: "c@example.com",
            projects: ["traceai"],
          }),
          listProjects: async () => [
            { slug: "traceai", fields: { name: "TraceAI" } },
          ],
          listTickets: async () => [],
          listReviewInbox: async () => [],
          getTicket: async () => liveTicket(),
          recordReviewVerdict: async () => ({
            ticket: ticketEntry({
              slug: "gated",
              stage: "todo",
              claimed_agent_id: claimed,
              review_state: "approved",
            }),
            cascaded: [],
          }),
          addComment: extras.addComment ?? (async () => ({})),
        } as never,
        cursorCloud: { followUp: extras.followUp },
        scheduleWakeup: (job) => jobs.push(job),
        nudgeQueue: queue,
        now: extras.now,
      });
      await fn({ app, token: token.token, queue, jobs });
    } finally {
      queue.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("returns 200 before the busy-retry window and later POSTs when Cursor is idle", async () => {
    const calls: string[] = [];
    let busy = true;
    let nowMs = Date.parse("2026-08-26T00:00:00.000Z");
    await withQueueApp(
      {
        now: () => new Date(nowMs),
        followUp: async (id) => {
          calls.push(id);
          if (busy) return { ok: false, status: 409, busy: true };
          return { ok: true, status: 201, busy: false };
        },
      },
      async ({ app, token, queue, jobs }) => {
        const started = Date.now();
        const res = await app.request("/v1/tickets/gated/review", {
          method: "POST",
          headers: authHeaders(token, {
            "x-traceai-human-proxy": PROXY_SECRET,
          }),
          body: JSON.stringify({ verdict: "approved" }),
        });
        const elapsed = Date.now() - started;
        assert.equal(res.status, 200, await res.text());
        assert.ok(elapsed < 2_000, `review HTTP waited ${elapsed}ms`);
        assert.equal(calls.length, 0);
        assert.equal(queue.listAll().length, 0);

        for (const job of jobs) job();
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(calls, ["bc-cloud-1"]);
        assert.equal(queue.listAll().length, 1);

        busy = false;
        nowMs += AGENT_BUSY_RETRY_MS;
        await processDueCloudNudges({
          store: queue,
          getClient: () => ({
            followUp: async (id) => {
              calls.push(id);
              return { ok: true, status: 201, busy: false };
            },
          }),
          loadTicket: async () =>
            ticketEntry({
              slug: "gated",
              stage: "todo",
              claimed_agent_id: "bc-cloud-1",
            }) as never,
          addComment: async () => {},
          now: () => new Date(nowMs),
          log: () => {},
        });
        assert.deepEqual(calls, ["bc-cloud-1", "bc-cloud-1"]);
        assert.equal(queue.listAll().length, 0);
      },
    );
  });

  it("does not enqueue missing-key or Cursor 500 (TRA-107 one-shot skip)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-nudge-skip-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    const queue = new NudgeQueueStore(":memory:");
    try {
      const user = store.createUser({ email: "c@example.com", name: "C" });
      const created = store.createToken({
        userId: user.id,
        name: "agent",
        scopes: [...DEFAULT_AGENT_SCOPES],
      });
      const token = created.token;
      const jobs: Array<() => void> = [];
      const missingKeyApp = createApp({
        authStore: store,
        service: {
          ...projectMemberStubs({
            email: "c@example.com",
            projects: ["traceai"],
          }),
          listProjects: async () => [
            { slug: "traceai", fields: { name: "TraceAI" } },
          ],
          listTickets: async () => [],
          listReviewInbox: async () => [],
          getTicket: async () =>
            wrappedTicket({ slug: "gated", claimed_agent_id: "bc-abc" }),
          recordReviewVerdict: async () => ({
            ticket: ticketEntry({
              slug: "gated",
              claimed_agent_id: "bc-abc",
              review_state: "approved",
            }),
            cascaded: [],
          }),
        } as never,
        cursorCloud: null,
        scheduleWakeup: (job) => jobs.push(job),
        nudgeQueue: queue,
      });
      const missing = await missingKeyApp.request("/v1/tickets/gated/review", {
        method: "POST",
        headers: authHeaders(token, {
          "x-traceai-human-proxy": PROXY_SECRET,
        }),
        body: JSON.stringify({ verdict: "approved" }),
      });
      assert.equal(missing.status, 200, await missing.text());
      for (const job of jobs) job();
      await new Promise((r) => setImmediate(r));
      assert.equal(queue.listAll().length, 0);

      jobs.length = 0;
      const fiveHundredApp = createApp({
        authStore: store,
        service: {
          ...projectMemberStubs({
            email: "c@example.com",
            projects: ["traceai"],
          }),
          listProjects: async () => [
            { slug: "traceai", fields: { name: "TraceAI" } },
          ],
          listTickets: async () => [],
          listReviewInbox: async () => [],
          getTicket: async () =>
            wrappedTicket({ slug: "gated", claimed_agent_id: "bc-abc" }),
          recordReviewVerdict: async () => ({
            ticket: ticketEntry({
              slug: "gated",
              claimed_agent_id: "bc-abc",
              review_state: "approved",
            }),
            cascaded: [],
          }),
        } as never,
        cursorCloud: {
          followUp: async () => ({ ok: false, status: 500, busy: false }),
        },
        scheduleWakeup: (job) => jobs.push(job),
        nudgeQueue: queue,
      });
      const five = await fiveHundredApp.request("/v1/tickets/gated/review", {
        method: "POST",
        headers: authHeaders(token, {
          "x-traceai-human-proxy": PROXY_SECRET,
        }),
        body: JSON.stringify({ verdict: "approved" }),
      });
      assert.equal(five.status, 200, await five.text());
      for (const job of jobs) job();
      await new Promise((r) => setImmediate(r));
      assert.equal(queue.listAll().length, 0);
    } finally {
      queue.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("two busy responses enqueue instead of silently dropping", async () => {
    const calls: number[] = [];
    let nowMs = Date.parse("2026-08-26T00:00:00.000Z");
    await withQueueApp(
      {
        now: () => new Date(nowMs),
        followUp: async () => {
          calls.push(1);
          return { ok: false, status: 409, busy: true };
        },
      },
      async ({ app, token, queue, jobs }) => {
        const res = await app.request("/v1/tickets/gated/review", {
          method: "POST",
          headers: authHeaders(token, {
            "x-traceai-human-proxy": PROXY_SECRET,
          }),
          body: JSON.stringify({ verdict: "approved" }),
        });
        assert.equal(res.status, 200, await res.text());
        for (const job of jobs) job();
        await new Promise((r) => setImmediate(r));
        assert.equal(calls.length, 1);
        assert.equal(queue.listAll().length, 1);

        nowMs += AGENT_BUSY_RETRY_MS;
        await processDueCloudNudges({
          store: queue,
          getClient: () => ({
            followUp: async () => {
              calls.push(1);
              return { ok: false, status: 409, busy: true };
            },
          }),
          loadTicket: async () =>
            ticketEntry({
              slug: "gated",
              claimed_agent_id: "bc-cloud-1",
            }) as never,
          addComment: async () => {},
          now: () => new Date(nowMs),
          log: () => {},
        });
        assert.equal(calls.length, 2);
        assert.equal(queue.listAll().length, 1);
        assert.equal(queue.listAll()[0]?.attempts, 2);
      },
    );
  });
});
