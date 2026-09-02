import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AuthStore, DEFAULT_AGENT_SCOPES } from "@traceai/auth";
import { createApp } from "./app.js";
import { getEventsAfter } from "./events.js";
import { projectMemberStubs } from "./test-support.js";
import {
  ACTIVITY_MAX_CHARS,
  configureTicketActivityStore,
} from "./ticket-activity.js";

function ticketEntry(
  overrides: Record<string, unknown> = {},
  fieldOverrides: Record<string, unknown> = {},
) {
  const slug = (overrides.slug as string) ?? "sample-ticket";
  return {
    id: `id-${slug}`,
    slug,
    fields: {
      slug,
      ticket_key: "TRA-141",
      ticket_number: 141,
      title: "Sample",
      description: "desc",
      project: "traceai",
      workflow: "traceai-default",
      stage: "in_progress",
      priority: "medium",
      claimed_agent_id: "bc-abc",
      claimed_by_user_id: "u1",
      ...fieldOverrides,
    },
  };
}

describe("PUT /v1/tickets/:slug/activity (TRA-141)", () => {
  it("sets activity, publishes ticket.activity, and does not add a comment", async () => {
    const directory = mkdtempSync(join(tmpdir(), "traceai-activity-"));
    const store = new AuthStore(join(directory, "auth.sqlite"));
    configureTicketActivityStore(":memory:");
    let comments = 0;
    let updates = 0;
    try {
      const user = store.createUser({ email: "a@example.com", name: "A" });
      const token = store.createToken({
        userId: user.id,
        name: "agent",
        scopes: [...DEFAULT_AGENT_SCOPES],
      });
      const before = getEventsAfter(0).at(-1)?.event_id ?? 0;
      const app = createApp({
        authStore: store,
        service: {
          ...projectMemberStubs({
            email: "a@example.com",
            projects: ["traceai"],
          }),
          getTicket: async () => ({
            ticket: ticketEntry(),
            comments: [],
            children: [],
            tokens_estimate_rollup: 0,
            tokens_actual_rollup: 0,
            parent_ticket: null,
          }),
          addComment: async () => {
            comments += 1;
            throw new Error("addComment must not run");
          },
          updateTicket: async () => {
            updates += 1;
            throw new Error("updateTicket must not run");
          },
          listProjectAgents: async () => [],
        } as never,
      });

      const tooLong = await app.request("/v1/tickets/sample-ticket/activity", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: "x".repeat(ACTIVITY_MAX_CHARS + 1) }),
      });
      assert.equal(tooLong.status, 400);

      const ok = await app.request("/v1/tickets/sample-ticket/activity", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: "nadenken" }),
      });
      assert.equal(ok.status, 200, await ok.clone().text());
      const body = (await ok.json()) as {
        activity?: string | null;
        activity_expires_at?: string | null;
      };
      assert.equal(body.activity, "nadenken");
      assert.ok(body.activity_expires_at);
      assert.equal(comments, 0);
      assert.equal(updates, 0);

      const events = getEventsAfter(before);
      const activity = events
        .map((row) => row.event)
        .filter((event) => event.type === "ticket.activity");
      assert.equal(activity.at(-1)?.activity, "nadenken");

      const getTicket = await app.request("/v1/tickets/sample-ticket", {
        headers: { Authorization: `Bearer ${token.token}` },
      });
      assert.equal(getTicket.status, 200);
      const ticketJson = (await getTicket.json()) as Record<string, unknown>;
      assert.equal(ticketJson.activity, undefined);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses activity on an unclaimed ticket", async () => {
    const directory = mkdtempSync(join(tmpdir(), "traceai-activity-"));
    const store = new AuthStore(join(directory, "auth.sqlite"));
    configureTicketActivityStore(":memory:");
    try {
      const user = store.createUser({ email: "b@example.com", name: "B" });
      const token = store.createToken({
        userId: user.id,
        name: "agent",
        scopes: [...DEFAULT_AGENT_SCOPES],
      });
      const app = createApp({
        authStore: store,
        service: {
          ...projectMemberStubs({
            email: "b@example.com",
            projects: ["traceai"],
          }),
          getTicket: async () => ({
            ticket: ticketEntry({}, { claimed_agent_id: "" }),
            comments: [],
            children: [],
            tokens_estimate_rollup: 0,
            tokens_actual_rollup: 0,
            parent_ticket: null,
          }),
          listProjectAgents: async () => [],
        } as never,
      });
      const res = await app.request("/v1/tickets/sample-ticket/activity", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: "nadenken" }),
      });
      assert.equal(res.status, 400);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
