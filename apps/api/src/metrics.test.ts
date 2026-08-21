import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, DEFAULT_AGENT_SCOPES } from "@traceai/auth";
import { createApp } from "./app.js";
import { configureNotificationStore } from "./notifications.js";
import { projectMemberStubs } from "./test-support.js";

const PROXY_SECRET = "metrics-proxy-secret";

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
      stage: "backlog",
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

function metricValue(
  body: string,
  name: string,
  labels: Record<string, string> = {},
): number {
  for (const line of body.split("\n")) {
    if (line.startsWith("#")) continue;
    if (!line.startsWith(name)) continue;
    const ok = Object.entries(labels).every(([key, value]) =>
      line.includes(`${key}="${value}"`),
    );
    if (!ok) continue;
    const match = line.match(/\s([0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?)\s*$/);
    if (match) return Number(match[1]);
  }
  return 0;
}

async function withApp(
  serviceExtra: Record<string, unknown>,
  fn: (app: ReturnType<typeof createApp>, token: string) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "traceai-metrics-"));
  const store = new AuthStore(join(dir, "auth.sqlite"));
  try {
    const user = store.createUser({ email: "m@example.com", name: "M" });
    const token = store.createToken({
      userId: user.id,
      name: "agent",
      scopes: [...DEFAULT_AGENT_SCOPES],
    });
    const app = createApp({
      authStore: store,
      service: {
        ...projectMemberStubs({
          email: "m@example.com",
          projects: ["traceai"],
        }),
        listProjects: async () => [{ slug: "traceai", fields: { name: "TraceAI" } }],
        listTickets: async () => [],
        listReviewInbox: async () => [],
        ...serviceExtra,
      } as never,
    });
    await fn(app, token.token);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function authHeaders(token: string, extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

describe("GET /metrics (TRA-96)", () => {
  const prevProxy = process.env.TRACEAI_HUMAN_PROXY_SECRET;

  before(() => {
    process.env.TRACEAI_HUMAN_PROXY_SECRET = PROXY_SECRET;
    configureNotificationStore(":memory:");
  });

  after(() => {
    if (prevProxy === undefined) delete process.env.TRACEAI_HUMAN_PROXY_SECRET;
    else process.env.TRACEAI_HUMAN_PROXY_SECRET = prevProxy;
  });

  it("T1/T2: unauthenticated scrape includes traceai_up and HELP lines", async () => {
    await withApp({}, async (app) => {
      const res = await app.request("/metrics");
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /# HELP traceai_up/);
      assert.match(body, /# TYPE traceai_tickets_created_total counter/);
      assert.match(body, /traceai_up 1/);
    });
  });

  it("T3: GET /health increments HTTP counter for the /health template", async () => {
    await withApp({}, async (app) => {
      const before = metricValue(
        await (await app.request("/metrics")).text(),
        "traceai_http_requests_total",
        { method: "GET", route: "/health", status: "200" },
      );
      const health = await app.request("/health");
      assert.equal(health.status, 200);
      const json = (await health.json()) as { status: string; service: string };
      assert.equal(json.status, "ok");
      assert.equal(json.service, "traceai-api");
      const after = metricValue(
        await (await app.request("/metrics")).text(),
        "traceai_http_requests_total",
        { method: "GET", route: "/health", status: "200" },
      );
      assert.ok(after >= before + 1);
    });
  });

  it("T2: creating a ticket increments traceai_tickets_created_total", async () => {
    await withApp(
      {
        createTicket: async () => ticketEntry({ slug: "new-ticket" }),
      },
      async (app, token) => {
        const before = metricValue(
          await (await app.request("/metrics")).text(),
          "traceai_tickets_created_total",
          { project: "traceai" },
        );
        const created = await app.request("/v1/tickets", {
          method: "POST",
          headers: authHeaders(token),
          body: JSON.stringify({
            project: "traceai",
            title: "Metrics sample",
            description: "Created to move the Prometheus counter",
          }),
        });
        assert.equal(created.status, 201);
        const after = metricValue(
          await (await app.request("/metrics")).text(),
          "traceai_tickets_created_total",
          { project: "traceai" },
        );
        assert.ok(after >= before + 1);
      },
    );
  });

  it("T3: transition increments from/to series and tokens_used", async () => {
    await withApp(
      {
        getTicket: async () => wrappedTicket({ slug: "move-me", stage: "todo" }),
        transitionTicket: async () =>
          ticketEntry({ slug: "move-me", stage: "in_progress" }),
      },
      async (app, token) => {
        const scrape = async () => (await app.request("/metrics")).text();
        const beforeT = metricValue(await scrape(), "traceai_ticket_transitions_total", {
          project: "traceai",
          from_stage: "todo",
          to_stage: "in_progress",
        });
        const beforeTokens = metricValue(await scrape(), "traceai_tokens_used_total", {
          project: "traceai",
        });
        const res = await app.request("/v1/tickets/move-me/transition", {
          method: "POST",
          headers: authHeaders(token, {
            "x-traceai-human-proxy": PROXY_SECRET,
          }),
          body: JSON.stringify({
            to_stage: "in_progress",
            tokens_used: 500,
            comment:
              "## Vorige stap\nReady in To do.\n\n## Deze stap\nMoving to In progress for metrics.",
          }),
        });
        assert.equal(res.status, 200, await res.text());
        const afterT = metricValue(await scrape(), "traceai_ticket_transitions_total", {
          project: "traceai",
          from_stage: "todo",
          to_stage: "in_progress",
        });
        const afterTokens = metricValue(await scrape(), "traceai_tokens_used_total", {
          project: "traceai",
        });
        assert.ok(afterT >= beforeT + 1);
        assert.ok(afterTokens >= beforeTokens + 500);
      },
    );
  });

  it("T4: review verdict increments traceai_ticket_reviews_total", async () => {
    await withApp(
      {
        getTicket: async () =>
          wrappedTicket({ slug: "review-me", stage: "refined" }),
        recordReviewVerdict: async () => ({
          ticket: ticketEntry({
            slug: "review-me",
            stage: "refined",
            review_state: "approved",
          }),
          cascaded: [],
        }),
      },
      async (app, token) => {
        const before = metricValue(
          await (await app.request("/metrics")).text(),
          "traceai_ticket_reviews_total",
          { project: "traceai", verdict: "approved" },
        );
        const res = await app.request("/v1/tickets/review-me/review", {
          method: "POST",
          headers: authHeaders(token, {
            "x-traceai-human-proxy": PROXY_SECRET,
          }),
          body: JSON.stringify({ verdict: "approved" }),
        });
        assert.equal(res.status, 200, await res.text());
        const after = metricValue(
          await (await app.request("/metrics")).text(),
          "traceai_ticket_reviews_total",
          { project: "traceai", verdict: "approved" },
        );
        assert.ok(after >= before + 1);
      },
    );
  });

  it("T5: adding a comment increments traceai_comments_created_total", async () => {
    await withApp(
      {
        getTicket: async () => wrappedTicket({ slug: "comment-me" }),
        addComment: async () => ({
          slug: "comment-1",
          fields: { ticket: "comment-me", body: "hi", author: "M" },
        }),
      },
      async (app, token) => {
        const before = metricValue(
          await (await app.request("/metrics")).text(),
          "traceai_comments_created_total",
          { project: "traceai" },
        );
        const res = await app.request("/v1/comments", {
          method: "POST",
          headers: authHeaders(token),
          body: JSON.stringify({ ticket: "comment-me", body: "A comment" }),
        });
        assert.equal(res.status, 201, await res.text());
        const after = metricValue(
          await (await app.request("/metrics")).text(),
          "traceai_comments_created_total",
          { project: "traceai" },
        );
        assert.ok(after >= before + 1);
      },
    );
  });

  it("T6: wiki create increments traceai_wiki_writes_total", async () => {
    await withApp(
      {
        createWikiPage: async () => ({
          slug: "metrics-note",
          updatedAt: "2026-08-21T00:00:00.000Z",
          fields: {
            title: "Metrics note",
            body: "n",
            project: "traceai",
            parent: null,
            sort_order: 0,
            updated_by: "M",
          },
        }),
      },
      async (app, token) => {
        const before = metricValue(
          await (await app.request("/metrics")).text(),
          "traceai_wiki_writes_total",
          { project: "traceai", op: "create" },
        );
        const res = await app.request("/v1/wiki-pages", {
          method: "POST",
          headers: authHeaders(token),
          body: JSON.stringify({
            project: "traceai",
            title: "Metrics note",
            body: "n",
          }),
        });
        assert.equal(res.status, 201, await res.text());
        const after = metricValue(
          await (await app.request("/metrics")).text(),
          "traceai_wiki_writes_total",
          { project: "traceai", op: "create" },
        );
        assert.ok(after >= before + 1);
      },
    );
  });

  it("T4/T7: route labels use templates; gauges match list counts", async () => {
    await withApp(
      {
        getTicket: async () => null,
        listTickets: async () => [
          ticketEntry({ slug: "alpha-ticket", stage: "in_progress" }),
          ticketEntry({ slug: "beta-ticket", stage: "in_progress" }),
          ticketEntry({
            slug: "gamma-ticket",
            stage: "refined",
            review_state: "approved",
          }),
        ],
        listReviewInbox: async () => [{ awaiting: "verdict" }],
      },
      async (app, token) => {
        await app.request("/v1/tickets/not-a-real-slug", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = await (await app.request("/metrics")).text();
        assert.equal(
          body.includes('route="not-a-real-slug"'),
          false,
          "raw ticket slug must not appear as a route label",
        );
        assert.ok(
          metricValue(body, "traceai_http_requests_total", {
            method: "GET",
            route: "/v1/tickets/:slug",
            status: "404",
          }) >= 1,
        );
        assert.equal(
          metricValue(body, "traceai_tickets", {
            project: "traceai",
            stage: "in_progress",
          }),
          2,
        );
        assert.equal(
          metricValue(body, "traceai_tickets", {
            project: "traceai",
            stage: "refined",
          }),
          1,
        );
        assert.equal(
          metricValue(body, "traceai_tickets_with_review_state", {
            project: "traceai",
            review_state: "approved",
          }),
          1,
        );
        assert.equal(metricValue(body, "traceai_inbox_reviews_open"), 1);
        assert.doesNotMatch(body, /alpha-ticket/);
        assert.doesNotMatch(body, /beta-ticket/);
      },
    );
  });
});
