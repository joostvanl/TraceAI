import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "@traceai/auth";
import { createApp } from "./app.js";
import { ticketEventFromMapped } from "./events.js";

function sampleTicketFields(overrides: Record<string, unknown> = {}) {
  return {
    slug: "sample-ticket",
    ticket_key: "TRA-1",
    ticket_number: 1,
    title: "Sample",
    description: "desc",
    project: "traceai",
    workflow: "wf",
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
    sort_order: 3,
    ...overrides,
  };
}

function ticketEntry(overrides: Record<string, unknown> = {}) {
  const fields = sampleTicketFields(overrides);
  return {
    id: `id-${fields.slug}`,
    slug: fields.slug as string,
    fields,
  };
}

describe("mapTicket / ticketEvent sort_order", () => {
  it("ticketEventFromMapped includes sort_order", () => {
    const event = ticketEventFromMapped("ticket.updated", sampleTicketFields());
    assert.equal(event.ticket.sort_order, 3);
  });
});

describe("POST /v1/tickets/reorder", () => {
  it("returns 403 without tickets:write scope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-reorder-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    try {
      const user = store.createUser({ email: "r@example.com", name: "R" });
      const token = store.createToken({
        userId: user.id,
        name: "read",
        scopes: ["tickets:read"],
      });
      const service = {
        reorderTickets: async () => {
          throw new Error("should not be called");
        },
      };
      const app = createApp({
        authStore: store,
        service: service as never,
      });
      const res = await app.request("/v1/tickets/reorder", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          project: "traceai",
          stage: "backlog",
          ordered_slugs: ["a"],
        }),
      });
      assert.equal(res.status, 403);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("happy path returns updated tickets and calls reorderTickets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-reorder-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    try {
      const user = store.createUser({ email: "w@example.com", name: "W" });
      const token = store.createToken({
        userId: user.id,
        name: "write",
        scopes: ["tickets:write"],
      });
      let called: unknown = null;
      const changed = [ticketEntry({ slug: "a", sort_order: 0 })];
      const service = {
        reorderTickets: async (input: unknown) => {
          called = input;
          return changed;
        },
      };
      const app = createApp({
        authStore: store,
        service: service as never,
      });
      const res = await app.request("/v1/tickets/reorder", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          project: "traceai",
          stage: "backlog",
          ordered_slugs: ["a", "b"],
        }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(called, {
        project: "traceai",
        stage: "backlog",
        ordered_slugs: ["a", "b"],
      });
      const body = (await res.json()) as {
        tickets: Array<{ slug: string; sort_order: number | null }>;
      };
      assert.equal(body.tickets.length, 1);
      assert.equal(body.tickets[0]?.slug, "a");
      assert.equal(body.tickets[0]?.sort_order, 0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PATCH accepts sort_order via updateTicket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-patch-sort-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    try {
      const user = store.createUser({ email: "p@example.com", name: "P" });
      const token = store.createToken({
        userId: user.id,
        name: "write",
        scopes: ["tickets:write"],
      });
      let patchBody: unknown = null;
      const service = {
        updateTicket: async (_slug: string, body: unknown) => {
          patchBody = body;
          return ticketEntry({ sort_order: 7 });
        },
      };
      const app = createApp({
        authStore: store,
        service: service as never,
      });
      const res = await app.request("/v1/tickets/sample-ticket", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sort_order: 7 }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(patchBody, { sort_order: 7 });
      const body = (await res.json()) as { sort_order: number | null };
      assert.equal(body.sort_order, 7);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
