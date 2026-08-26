import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, DEFAULT_AGENT_SCOPES } from "@traceai/auth";
import { createApp } from "./app.js";
import { DEFAULT_TRACEAI_PUBLIC_API_URL } from "./mcp.js";

function mcpInitializeBody() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "traceai-mcp-test", version: "0.0.0" },
    },
  };
}

describe("hosted MCP /mcp", () => {
  it("returns 401 without Authorization", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-mcp-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    try {
      const app = createApp({
        authStore: store,
        service: {} as never,
      });
      const res = await app.request("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(mcpInitializeBody()),
      });
      assert.equal(res.status, 401);
      const body = (await res.json()) as { code?: string };
      assert.equal(body.code, "UNAUTHORIZED");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 401 for non-trc token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-mcp-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    try {
      const app = createApp({
        authStore: store,
        service: {} as never,
      });
      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer aurora_not_allowed",
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(mcpInitializeBody()),
      });
      assert.equal(res.status, 401);
      const body = (await res.json()) as { code?: string };
      assert.equal(body.code, "INVALID_TOKEN");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("initialize + tools/list with valid token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-mcp-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    try {
      const user = store.createUser({ email: "mcp@example.com", name: "Mcp" });
      const token = store.createToken({
        userId: user.id,
        name: "agent",
        scopes: [...DEFAULT_AGENT_SCOPES],
      });
      const app = createApp({
        authStore: store,
        service: {
          listProjects: async () => [],
        } as never,
      });

      const initRes = await app.request("/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(mcpInitializeBody()),
      });
      assert.equal(initRes.status, 200, await initRes.clone().text());
      const initJson = (await initRes.json()) as {
        result?: { serverInfo?: { name?: string } };
      };
      assert.equal(initJson.result?.serverInfo?.name, "traceai");

      const listRes = await app.request("/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      });
      assert.equal(listRes.status, 200, await listRes.clone().text());
      const listJson = (await listRes.json()) as {
        result?: { tools?: Array<{ name: string }> };
      };
      const names = (listJson.result?.tools ?? []).map((t) => t.name);
      assert.ok(names.includes("list_projects"));
      assert.ok(names.includes("get_ticket"));
      assert.ok(names.includes("transition_ticket"));
      assert.ok(names.includes("claim_ticket"));
      assert.ok(names.includes("create_wiki_page"));
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tools/call list_projects returns public api_base via in-process client", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-mcp-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    try {
      const user = store.createUser({ email: "mcp2@example.com", name: "Mcp2" });
      const token = store.createToken({
        userId: user.id,
        name: "agent",
        scopes: [...DEFAULT_AGENT_SCOPES],
      });
      const app = createApp({
        authStore: store,
        service: {
          listProjects: async () => [
            {
              id: "1",
              slug: "traceai",
              fields: {
                name: "TraceAI",
                description: "",
                default_workflow: null,
                project_key: "TRA",
              },
            },
          ],
          getWorkflow: async () => null,
          // Project access is membership-based since TRA-81, so listing projects
          // now resolves the TraceAI user behind the token. This token has no
          // matching user, so the filtered list is empty — that is the intended
          // deny-by-default. This test is about api_base plumbing, not filtering.
          listTraceaiUsers: async () => [],
          getTraceaiUser: async () => null,
          listProjectMemberships: async () => [],
        } as never,
      });

      const callRes = await app.request("/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "list_projects", arguments: {} },
        }),
      });
      assert.equal(callRes.status, 200, await callRes.clone().text());
      const callJson = (await callRes.json()) as {
        result?: { content?: Array<{ text?: string }> };
      };
      const text = callJson.result?.content?.[0]?.text ?? "";
      const payload = JSON.parse(text) as { api_base?: string; result?: unknown };
      assert.equal(payload.api_base, DEFAULT_TRACEAI_PUBLIC_API_URL);
      assert.ok(Array.isArray(payload.result) || Array.isArray(payload));
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
