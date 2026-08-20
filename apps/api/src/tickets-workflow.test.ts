import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "@traceai/auth";
import { createApp } from "./app.js";
import { projectMemberStubs } from "./test-support.js";

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

describe("GET /v1/tickets?workflow=", () => {
  it("filters by exact pin and keeps roll-ups from the full project set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-tickets-wf-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    try {
      const user = store.createUser({ email: "r@example.com", name: "R" });
      const token = store.createToken({
        userId: user.id,
        name: "read",
        scopes: ["tickets:read"],
      });
      const service = {
        ...projectMemberStubs({ email: "r@example.com", projects: ["traceai"] }),
        listTickets: async () => [
          ticketEntry({
            slug: "default-ticket",
            workflow: "traceai-default",
            tokens_estimate: 10,
          }),
          ticketEntry({
            slug: "worker-ticket",
            workflow: "standard-worker",
            tokens_estimate: 20,
          }),
          ticketEntry({
            slug: "wees-ticket",
            workflow: "traceai-product-development",
            tokens_estimate: 30,
          }),
        ],
      };
      const app = createApp({
        authStore: store,
        service: service as never,
      });
      const filtered = await app.request(
        "/v1/tickets?project=traceai&workflow=standard-worker",
        { headers: { Authorization: `Bearer ${token.token}` } },
      );
      assert.equal(filtered.status, 200);
      const filteredBody = (await filtered.json()) as Array<{ slug: string }>;
      assert.deepEqual(
        filteredBody.map((t) => t.slug),
        ["worker-ticket"],
      );

      const all = await app.request("/v1/tickets?project=traceai", {
        headers: { Authorization: `Bearer ${token.token}` },
      });
      assert.equal(all.status, 200);
      const allBody = (await all.json()) as Array<{ slug: string }>;
      assert.equal(allBody.length, 3);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("L3: workflow + stage is an intersection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-tickets-wf-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    try {
      const user = store.createUser({ email: "r@example.com", name: "R" });
      const token = store.createToken({
        userId: user.id,
        name: "read",
        scopes: ["tickets:read"],
      });
      const service = {
        ...projectMemberStubs({ email: "r@example.com", projects: ["traceai"] }),
        listTickets: async () => [
          ticketEntry({
            slug: "worker-backlog",
            workflow: "standard-worker",
            stage: "backlog",
          }),
          ticketEntry({
            slug: "worker-todo",
            workflow: "standard-worker",
            stage: "todo",
          }),
          ticketEntry({
            slug: "default-backlog",
            workflow: "traceai-default",
            stage: "backlog",
          }),
        ],
      };
      const app = createApp({
        authStore: store,
        service: service as never,
      });
      const res = await app.request(
        "/v1/tickets?project=traceai&workflow=standard-worker&stage=backlog",
        { headers: { Authorization: `Bearer ${token.token}` } },
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as Array<{ slug: string }>;
      assert.deepEqual(
        body.map((t) => t.slug),
        ["worker-backlog"],
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("L4: unknown workflow slug returns an empty list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-tickets-wf-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    try {
      const user = store.createUser({ email: "r@example.com", name: "R" });
      const token = store.createToken({
        userId: user.id,
        name: "read",
        scopes: ["tickets:read"],
      });
      const service = {
        ...projectMemberStubs({ email: "r@example.com", projects: ["traceai"] }),
        listTickets: async () => [
          ticketEntry({ slug: "default-ticket", workflow: "traceai-default" }),
        ],
      };
      const app = createApp({
        authStore: store,
        service: service as never,
      });
      const res = await app.request(
        "/v1/tickets?project=traceai&workflow=does-not-exist",
        { headers: { Authorization: `Bearer ${token.token}` } },
      );
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), []);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("L5: roll-up still uses the full project set when the list is filtered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-tickets-wf-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    try {
      const user = store.createUser({ email: "r@example.com", name: "R" });
      const token = store.createToken({
        userId: user.id,
        name: "read",
        scopes: ["tickets:read"],
      });
      const service = {
        ...projectMemberStubs({ email: "r@example.com", projects: ["traceai"] }),
        listTickets: async () => [
          ticketEntry({
            slug: "parent-ticket",
            workflow: "standard-worker",
            tokens_estimate: 10,
          }),
          ticketEntry({
            slug: "child-ticket",
            workflow: "traceai-default",
            parent: "parent-ticket",
            tokens_estimate: 30,
          }),
        ],
      };
      const app = createApp({
        authStore: store,
        service: service as never,
      });
      const res = await app.request(
        "/v1/tickets?project=traceai&workflow=standard-worker",
        { headers: { Authorization: `Bearer ${token.token}` } },
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as Array<{
        slug: string;
        tokens_estimate_rollup: number;
      }>;
      assert.equal(body.length, 1);
      assert.equal(body[0]?.slug, "parent-ticket");
      assert.equal(body[0]?.tokens_estimate_rollup, 40);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
