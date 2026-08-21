import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "@traceai/auth";
import { ValidationError } from "@traceai/core";
import { createApp } from "./app.js";
import { projectMemberStubs } from "./test-support.js";

function ticketEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "id-sample",
    slug: "sample-ticket",
    fields: {
      title: "Sample",
      description: "desc",
      project: "traceai",
      workflow: "traceai-default",
      stage: "backlog",
      priority: "medium",
      ticket_key: "TRA-1",
      ticket_number: 1,
      tokens_estimate: null,
      tokens_actual: null,
      resolution: null,
      review_state: null,
      parent: null,
      sort_order: 0,
      ...overrides,
    },
  };
}

describe("PATCH /v1/tickets/:slug workflow (TRA-95)", () => {
  it("T8: forwards workflow (and author) to updateTicket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-patch-wf-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    try {
      const user = store.createUser({ email: "w@example.com", name: "W" });
      const token = store.createToken({
        userId: user.id,
        name: "write",
        scopes: ["tickets:write"],
      });
      let patchBody: unknown = null;
      const service = {
        ...projectMemberStubs({ email: "w@example.com", projects: ["traceai"] }),
        getTicket: async () => ({ ticket: ticketEntry() }),
        updateTicket: async (_slug: string, body: unknown) => {
          patchBody = body;
          return ticketEntry({ workflow: "standard-worker", stage: "backlog" });
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
        body: JSON.stringify({ workflow: "standard-worker" }),
      });
      assert.equal(res.status, 200);
      assert.equal(
        (patchBody as { workflow?: string }).workflow,
        "standard-worker",
      );
      assert.equal(typeof (patchBody as { author?: string }).author, "string");
      const body = (await res.json()) as { workflow?: string };
      assert.equal(body.workflow, "standard-worker");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps ValidationError from a non-first-stage pin-wissel to 400", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-patch-wf-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    try {
      const user = store.createUser({ email: "w@example.com", name: "W" });
      const token = store.createToken({
        userId: user.id,
        name: "write",
        scopes: ["tickets:write"],
      });
      const service = {
        ...projectMemberStubs({ email: "w@example.com", projects: ["traceai"] }),
        getTicket: async () => ({
          ticket: ticketEntry({ stage: "todo" }),
        }),
        updateTicket: async () => {
          throw new ValidationError(
            'Workflow can only be changed while the ticket is in the first stage ("Backlog").',
          );
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
        body: JSON.stringify({ workflow: "standard-worker" }),
      });
      assert.equal(res.status, 400);
      assert.equal(((await res.json()) as { code?: string }).code, "VALIDATION");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
