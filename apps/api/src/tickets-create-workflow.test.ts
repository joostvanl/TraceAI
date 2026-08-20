import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "@traceai/auth";
import { ValidationError } from "@traceai/core";
import { createApp } from "./app.js";
import { projectMemberStubs } from "./test-support.js";

describe("POST /v1/tickets workflow pin (TRA-87)", () => {
  it("C2: omits workflow so the service can pin default_workflow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-create-wf-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    try {
      const user = store.createUser({ email: "w@example.com", name: "W" });
      const token = store.createToken({
        userId: user.id,
        name: "write",
        scopes: ["tickets:write"],
      });
      let called: unknown = null;
      const service = {
        ...projectMemberStubs({ email: "w@example.com", projects: ["traceai"] }),
        createTicket: async (input: unknown) => {
          called = input;
          return {
            id: "id-new",
            slug: "new-ticket",
            fields: {
              title: "New",
              description: "desc",
              project: "traceai",
              workflow: "traceai-default",
              stage: "backlog",
              priority: "medium",
              ticket_key: "TRA-100",
              ticket_number: 100,
              tokens_estimate: null,
              tokens_actual: null,
              resolution: null,
              review_state: null,
              parent: null,
              sort_order: 0,
            },
          };
        },
      };
      const app = createApp({
        authStore: store,
        service: service as never,
      });
      const res = await app.request("/v1/tickets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          project: "traceai",
          title: "New",
          description: "A short wish for the default board",
        }),
      });
      assert.equal(res.status, 201);
      assert.equal((called as { workflow?: string }).workflow, undefined);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("C3/C4: unknown stage or dead workflow slug is 400 VALIDATION", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-create-wf-"));
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
        createTicket: async (input: { workflow?: string; stage?: string }) => {
          if (input.workflow === "traceai-product-development") {
            throw new ValidationError(
              `Workflow "${input.workflow}" is not a workflow of project traceai`,
            );
          }
          if (input.stage === "not-a-stage") {
            throw new ValidationError(
              `Stage "${input.stage}" is not in workflow standard-worker`,
            );
          }
          throw new Error("unexpected");
        },
      };
      const app = createApp({
        authStore: store,
        service: service as never,
      });
      const dead = await app.request("/v1/tickets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          project: "traceai",
          title: "Dead pin",
          description: "should not create",
          workflow: "traceai-product-development",
        }),
      });
      assert.equal(dead.status, 400);
      assert.equal(((await dead.json()) as { code?: string }).code, "VALIDATION");

      const badStage = await app.request("/v1/tickets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          project: "traceai",
          title: "Bad stage",
          description: "should not create",
          workflow: "standard-worker",
          stage: "not-a-stage",
        }),
      });
      assert.equal(badStage.status, 400);
      assert.equal(
        ((await badStage.json()) as { code?: string }).code,
        "VALIDATION",
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
