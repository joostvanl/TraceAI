import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "@traceai/auth";
import { NotFoundError } from "@traceai/core";
import { createApp } from "./app.js";
import { projectMemberStubs } from "./test-support.js";

const stages = [
  {
    key: "backlog",
    name: "Backlog",
    transitions: ["todo"],
    agent: { purpose: "Parked ideas with a long instruction" },
  },
  {
    key: "todo",
    name: "To do",
    transitions: [],
    agent: { purpose: "Queue only" },
  },
];

const document = {
  version: 2,
  agent_policy: { summary: "Keep tickets thin.", on_every_transition: [] },
  stages,
};

describe("slim workflow reads (TRA-153)", () => {
  it("get_workflow default is a table of contents; include=full is the whole book", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-wf-slim-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    try {
      const user = store.createUser({ email: "r@example.com", name: "R" });
      const token = store.createToken({
        userId: user.id,
        name: "read",
        scopes: ["workflows:read", "projects:read"],
      });
      const service = {
        ...projectMemberStubs({ email: "r@example.com", projects: ["traceai"] }),
        getProjectLiveBoardActivity: async () => false,
        getWorkflow: async (slug: string) => {
          if (slug !== "story") return null;
          return {
            workflow: {
              slug,
              fields: { name: "Story", project: "traceai" },
            },
            stages,
            workflow_document: document,
          };
        },
        getWorkflowStage: async (workflow: string, key: string) => {
          if (workflow !== "story") throw new Error("missing workflow");
          const stage = stages.find((item) => item.key === key);
          if (!stage) throw new NotFoundError(`Stage not found: ${key}`);
          return stage;
        },
        getProject: async (slug: string) => {
          if (slug !== "traceai") return null;
          return {
            project: { slug, fields: { name: "TraceAI" } },
            workflow: {
              slug: "story",
              fields: { name: "Story", project: "traceai" },
            },
            stages,
            workflow_document: document,
          };
        },
        saveWorkflowDraft: async () => {
          throw new Error("editor writes are not exercised here");
        },
      };
      const app = createApp({
        authStore: store,
        service: service as never,
      });
      const headers = { Authorization: `Bearer ${token.token}` };

      const slim = await app.request("/v1/workflows/story", { headers });
      assert.equal(slim.status, 200);
      const slimBody = (await slim.json()) as {
        stages: Array<Record<string, unknown>>;
        workflow_document?: unknown;
        storage_model?: string;
      };
      assert.equal(slimBody.storage_model, "legacy_json");
      assert.equal(slimBody.workflow_document, undefined);
      assert.equal("agent" in slimBody.stages[0], false);
      assert.equal(slimBody.stages[0].key, "backlog");
      assert.ok(!JSON.stringify(slimBody).includes("Parked ideas"));

      const full = await app.request("/v1/workflows/story?include=full", {
        headers,
      });
      const fullBody = (await full.json()) as {
        stages: Array<{ agent?: { purpose?: string } }>;
        workflow_document: { stages: typeof stages };
      };
      assert.equal(fullBody.stages[0].agent?.purpose, "Parked ideas with a long instruction");
      assert.ok(fullBody.workflow_document);

      const project = await app.request("/v1/projects/traceai", { headers });
      const projectBody = (await project.json()) as {
        agent_playbook: { stages: Array<Record<string, unknown>> };
      };
      assert.equal("agent" in projectBody.agent_playbook.stages[0], false);

      const one = await app.request("/v1/workflows/story/stages/backlog", {
        headers,
      });
      assert.equal(one.status, 200);
      const oneBody = (await one.json()) as { agent?: { purpose?: string } };
      assert.equal(oneBody.agent?.purpose, "Parked ideas with a long instruction");

      const missing = await app.request("/v1/workflows/story/stages/nope", {
        headers,
      });
      assert.equal(missing.status, 404);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
