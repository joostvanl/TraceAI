import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, DEFAULT_AGENT_SCOPES } from "@traceai/auth";
import { createApp } from "./app.js";
import { signHumanIdentity } from "./human-identity.js";
import { projectMemberStubs } from "./test-support.js";

const PROXY_SECRET = "agent-apis-proxy";
const SESSION_SECRET = "agent-apis-session-secret";

function authHeaders(
  token: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

function personalHeaders(token: string, slug: string): Record<string, string> {
  return authHeaders(token, {
    "x-traceai-human-proxy": PROXY_SECRET,
    "x-traceai-human-identity": signHumanIdentity(
      {
        user: slug,
        slug,
        display_name: slug,
        is_platform_admin: false,
        mode: "personal",
      },
      SESSION_SECRET,
    ),
  });
}

describe("GET/PUT/DELETE /v1/me/agent-apis (TRA-114)", () => {
  const prevProxy = process.env.TRACEAI_HUMAN_PROXY_SECRET;
  const prevSession = process.env.TRACEAI_SESSION_SECRET;
  const prevAgent = process.env.TRACEAI_AGENT_API_SECRET;

  before(() => {
    process.env.TRACEAI_HUMAN_PROXY_SECRET = PROXY_SECRET;
    process.env.TRACEAI_SESSION_SECRET = SESSION_SECRET;
    delete process.env.TRACEAI_AGENT_API_SECRET;
  });

  after(() => {
    if (prevProxy === undefined) delete process.env.TRACEAI_HUMAN_PROXY_SECRET;
    else process.env.TRACEAI_HUMAN_PROXY_SECRET = prevProxy;
    if (prevSession === undefined) delete process.env.TRACEAI_SESSION_SECRET;
    else process.env.TRACEAI_SESSION_SECRET = prevSession;
    if (prevAgent === undefined) delete process.env.TRACEAI_AGENT_API_SECRET;
    else process.env.TRACEAI_AGENT_API_SECRET = prevAgent;
  });

  async function withApp(
    fn: (input: {
      app: ReturnType<typeof createApp>;
      token: string;
      userId: string;
    }) => Promise<void>,
  ) {
    const dir = mkdtempSync(join(tmpdir(), "traceai-agent-apis-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    try {
      const user = store.createUser({
        email: "ui+alice@users.traceai.local",
        name: "Alice",
      });
      const token = store.createToken({
        userId: user.id,
        name: "web",
        scopes: [...DEFAULT_AGENT_SCOPES],
      });
      const app = createApp({
        authStore: store,
        service: {
          ...projectMemberStubs({
            email: "ui+alice@users.traceai.local",
            userSlug: "alice",
            projects: ["traceai"],
          }),
          getTraceaiUser: async (slug: string) =>
            slug === "alice"
              ? {
                  id: "id-alice",
                  slug: "alice",
                  fields: {
                    username: "alice",
                    display_name: "Alice",
                    status: "active",
                  },
                }
              : null,
        } as never,
        cursorCloud: null,
      });
      await fn({ app, token: token.token, userId: user.id });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("saves, replaces, and deletes a Cursor key without returning the secret", async () => {
    await withApp(async ({ app, token }) => {
      const headers = personalHeaders(token, "alice");
      const empty = await app.request("/v1/me/agent-apis", { headers });
      assert.equal(empty.status, 200, await empty.clone().text());
      const listed = (await empty.json()) as {
        items: Array<{ provider: string; configured: boolean; last4: string | null }>;
        default_cursor_agent_id?: unknown;
      };
      assert.equal("default_cursor_agent_id" in listed, false);
      assert.deepEqual(
        listed.items.map((i) => i.provider),
        ["cursor", "claude_code", "codex"],
      );
      assert.equal(listed.items.find((i) => i.provider === "cursor")?.configured, false);

      const put = await app.request("/v1/me/agent-apis/cursor", {
        method: "PUT",
        headers,
        body: JSON.stringify({ api_key: "key_first_save_ABCD" }),
      });
      assert.equal(put.status, 200, await put.clone().text());
      const saved = (await put.json()) as Record<string, unknown>;
      assert.equal(saved.configured, true);
      assert.equal(saved.last4, "ABCD");
      assert.equal(saved.api_key, undefined);
      assert.equal(JSON.stringify(saved).includes("key_first_save_ABCD"), false);

      const got = await app.request("/v1/me/agent-apis", { headers });
      const afterSave = (await got.json()) as typeof listed;
      const cursor = afterSave.items.find((i) => i.provider === "cursor");
      assert.equal(cursor?.configured, true);
      assert.equal(cursor?.last4, "ABCD");
      assert.equal(JSON.stringify(afterSave).includes("key_first_save_ABCD"), false);

      const replace = await app.request("/v1/me/agent-apis/cursor", {
        method: "PUT",
        headers,
        body: JSON.stringify({ api_key: "  key_replaced_WXYZ  " }),
      });
      assert.equal(replace.status, 200);
      const replaced = (await replace.json()) as { last4?: string };
      assert.equal(replaced.last4, "WXYZ");

      const del = await app.request("/v1/me/agent-apis/cursor", {
        method: "DELETE",
        headers,
      });
      assert.equal(del.status, 200, await del.clone().text());
      const cleared = await app.request("/v1/me/agent-apis", { headers });
      const afterDel = (await cleared.json()) as typeof listed;
      assert.equal(
        afterDel.items.find((i) => i.provider === "cursor")?.configured,
        false,
      );
      assert.equal(afterDel.items.find((i) => i.provider === "cursor")?.last4, null);
    });
  });

  it("rejects whitespace agent ids", async () => {
    await withApp(async ({ app, token }) => {
      const res = await app.request("/v1/projects/traceai/me/default-agent", {
        method: "PUT",
        headers: personalHeaders(token, "alice"),
        body: JSON.stringify({ agent_id: "bc one" }),
      });
      assert.equal(res.status, 400);
    });
  });

  it("rejects empty keys and non-cursor providers", async () => {
    await withApp(async ({ app, token }) => {
      const headers = personalHeaders(token, "alice");
      const empty = await app.request("/v1/me/agent-apis/cursor", {
        method: "PUT",
        headers,
        body: JSON.stringify({ api_key: "   " }),
      });
      assert.equal(empty.status, 400);

      const claude = await app.request("/v1/me/agent-apis/claude_code", {
        method: "PUT",
        headers,
        body: JSON.stringify({ api_key: "sk-claude" }),
      });
      assert.equal(claude.status, 400);

      const codex = await app.request("/v1/me/agent-apis/codex", {
        method: "PUT",
        headers,
        body: JSON.stringify({ api_key: "sk-codex" }),
      });
      assert.equal(codex.status, 400);
    });
  });

  it("rejects legacy login", async () => {
    await withApp(async ({ app, token }) => {
      const headers = authHeaders(token, {
        "x-traceai-human-proxy": PROXY_SECRET,
        "x-traceai-human-identity": signHumanIdentity(
          {
            user: "shared",
            slug: null,
            display_name: "Legacy",
            is_platform_admin: false,
            mode: "legacy",
          },
          SESSION_SECRET,
        ),
      });
      const res = await app.request("/v1/me/agent-apis/cursor", {
        method: "PUT",
        headers,
        body: JSON.stringify({ api_key: "key_nope" }),
      });
      assert.equal(res.status, 403);
    });
  });
});
