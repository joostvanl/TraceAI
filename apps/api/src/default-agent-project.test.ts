import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, DEFAULT_AGENT_SCOPES } from "@traceai/auth";
import { createApp } from "./app.js";
import { signHumanIdentity } from "./human-identity.js";
import { projectMemberStubs } from "./test-support.js";

const PROXY_SECRET = "default-agent-project-proxy";
const SESSION_SECRET = "default-agent-project-session";

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

function personalHeaders(
  token: string,
  slug: string,
  extras: { platformAdmin?: boolean } = {},
): Record<string, string> {
  return authHeaders(token, {
    "x-traceai-human-proxy": PROXY_SECRET,
    "x-traceai-human-identity": signHumanIdentity(
      {
        user: slug,
        slug,
        display_name: slug,
        is_platform_admin: extras.platformAdmin === true,
        mode: "personal",
      },
      SESSION_SECRET,
    ),
  });
}

describe("GET/PUT /v1/projects/:slug/default-agent (TRA-137)", () => {
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
      stubs: ReturnType<typeof projectMemberStubs>;
    }) => Promise<void>,
    extras: {
      projects?: string[];
      role?: "admin" | "editor" | "viewer";
      enforceRoles?: boolean;
      isPlatformAdmin?: boolean;
      userSlug?: string;
    } = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), "traceai-default-project-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    try {
      const userSlug = extras.userSlug ?? "alice";
      const user = store.createUser({
        email: `ui+${userSlug}@users.traceai.local`,
        name: userSlug,
      });
      const token = store.createToken({
        userId: user.id,
        name: "web",
        scopes: [...DEFAULT_AGENT_SCOPES],
      });
      const stubs = projectMemberStubs({
        email: `ui+${userSlug}@users.traceai.local`,
        userSlug,
        projects: extras.projects ?? ["traceai", "other"],
        role: extras.role ?? "admin",
        enforceRoles: extras.enforceRoles,
        isPlatformAdmin: extras.isPlatformAdmin,
      });
      const app = createApp({
        authStore: store,
        service: {
          ...stubs,
          getTraceaiUser: async (slug: string) =>
            slug === userSlug
              ? {
                  id: `id-${userSlug}`,
                  slug: userSlug,
                  fields: {
                    username: userSlug,
                    display_name: userSlug,
                    status: "active",
                    is_platform_admin: extras.isPlatformAdmin === true,
                  },
                }
              : null,
        } as never,
        cursorCloud: null,
      });
      await fn({ app, token: token.token, stubs });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("saves, replaces, and clears per project without leaking across projects", async () => {
    await withApp(async ({ app, token }) => {
      const headers = personalHeaders(token, "alice");
      const put = await app.request("/v1/projects/traceai/default-agent", {
        method: "PUT",
        headers,
        body: JSON.stringify({ agent_id: "bc-default-1" }),
      });
      assert.equal(put.status, 200, await put.clone().text());
      assert.equal(
        ((await put.json()) as { agent_id?: string }).agent_id,
        "bc-default-1",
      );

      const got = await app.request("/v1/projects/traceai/default-agent", {
        headers,
      });
      assert.equal(
        ((await got.json()) as { agent_id?: string | null }).agent_id,
        "bc-default-1",
      );

      const other = await app.request("/v1/projects/other/default-agent", {
        headers,
      });
      assert.equal(
        ((await other.json()) as { agent_id?: string | null }).agent_id,
        null,
      );

      const replaced = await app.request(
        "/v1/projects/traceai/default-agent",
        {
          method: "PUT",
          headers,
          body: JSON.stringify({ agent_id: "local-agent" }),
        },
      );
      assert.equal(replaced.status, 200);
      assert.equal(
        ((await replaced.json()) as { agent_id?: string }).agent_id,
        "local-agent",
      );

      const cleared = await app.request(
        "/v1/projects/traceai/default-agent",
        {
          method: "PUT",
          headers,
          body: JSON.stringify({ agent_id: "" }),
        },
      );
      assert.equal(cleared.status, 200);
      assert.equal(
        ((await cleared.json()) as { agent_id?: string | null }).agent_id,
        null,
      );
    });
  });

  it("lets a bearer token (MCP) set the default without a human proxy", async () => {
    await withApp(async ({ app, token }) => {
      const res = await app.request("/v1/projects/traceai/default-agent", {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify({ agent_id: "bc-mcp-self" }),
      });
      assert.equal(res.status, 200, await res.clone().text());
      assert.equal(
        ((await res.json()) as { agent_id?: string }).agent_id,
        "bc-mcp-self",
      );
    });
  });

  it("rejects editor PUT with 403", async () => {
    await withApp(
      async ({ app, token }) => {
        const res = await app.request("/v1/projects/traceai/default-agent", {
          method: "PUT",
          headers: personalHeaders(token, "alice"),
          body: JSON.stringify({ agent_id: "bc-nope" }),
        });
        assert.equal(res.status, 403, await res.clone().text());
      },
      { role: "editor", enforceRoles: true },
    );
  });

  it("lets a platform admin set the default without a membership row", async () => {
    await withApp(
      async ({ app, token }) => {
        const headers = personalHeaders(token, "boss", { platformAdmin: true });
        const put = await app.request("/v1/projects/traceai/default-agent", {
          method: "PUT",
          headers,
          body: JSON.stringify({ agent_id: "bc-platform-1" }),
        });
        assert.equal(put.status, 200, await put.clone().text());
        const got = await app.request("/v1/projects/traceai/default-agent", {
          headers,
        });
        assert.equal(
          ((await got.json()) as { agent_id?: string | null }).agent_id,
          "bc-platform-1",
        );
      },
      { userSlug: "boss", isPlatformAdmin: true, projects: [] },
    );
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
      const res = await app.request("/v1/projects/traceai/default-agent", {
        method: "PUT",
        headers,
        body: JSON.stringify({ agent_id: "bc-nope" }),
      });
      assert.ok(
        res.status === 404 || res.status === 403,
        `expected 404 or 403, got ${res.status}`,
      );
    });
  });

  it("role updates do not wipe the project default", async () => {
    await withApp(async ({ app, token, stubs }) => {
      const headers = personalHeaders(token, "alice");
      await app.request("/v1/projects/traceai/default-agent", {
        method: "PUT",
        headers,
        body: JSON.stringify({ agent_id: "bc-keep-me" }),
      });
      await stubs.setProjectMembership({
        project: "traceai",
        user: "alice",
        role: "editor",
      });
      const got = await app.request("/v1/projects/traceai/default-agent", {
        headers,
      });
      assert.equal(
        ((await got.json()) as { agent_id?: string | null }).agent_id,
        "bc-keep-me",
      );
    });
  });

  it("ignores leftover membership defaults after the project field is cleared", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-default-cleared-"));
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
      const stubs = projectMemberStubs({
        email: "ui+alice@users.traceai.local",
        userSlug: "alice",
        projects: ["traceai"],
        defaultByProject: { traceai: null },
        membershipDefaultByProject: { traceai: "bc-old-membership" },
      });
      const app = createApp({
        authStore: store,
        service: {
          ...stubs,
          getTraceaiUser: async () => ({
            id: "id-alice",
            slug: "alice",
            fields: { username: "alice", status: "active" },
          }),
        } as never,
        cursorCloud: null,
      });
      const got = await app.request("/v1/projects/traceai/default-agent", {
        headers: personalHeaders(token.token, "alice"),
      });
      assert.equal(got.status, 200, await got.clone().text());
      assert.equal(
        ((await got.json()) as { agent_id?: string | null }).agent_id,
        null,
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
