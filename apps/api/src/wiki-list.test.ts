import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, DEFAULT_AGENT_SCOPES } from "@traceai/auth";
import { createApp } from "./app.js";

function wikiEntry(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `id-${slug}`,
    slug,
    updatedAt: "2026-08-17T00:00:00.000Z",
    fields: {
      title: slug,
      body: `# ${slug}\n\nlong markdown body`,
      project: "traceai",
      parent: null,
      sort_order: 0,
      updated_by: "agent",
      ...overrides,
    },
  };
}

/** Runs `fn` against an app whose service returns the given wiki envelope. */
async function withApp(
  listWikiPages: (input: unknown) => Promise<unknown>,
  fn: (app: ReturnType<typeof createApp>, token: string) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "traceai-wiki-list-"));
  const store = new AuthStore(join(dir, "auth.sqlite"));
  try {
    const user = store.createUser({ email: "w@example.com", name: "W" });
    const token = store.createToken({
      userId: user.id,
      name: "agent",
      scopes: [...DEFAULT_AGENT_SCOPES],
    });
    const app = createApp({
      authStore: store,
      service: { listWikiPages } as never,
    });
    await fn(app, token.token);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("GET /v1/wiki-pages", () => {
  it("returns an envelope and omits page bodies by default", async () => {
    await withApp(
      async () => ({
        items: [wikiEntry("home"), wikiEntry("architecture")],
        total: 42,
        limit: 500,
        offset: 0,
      }),
      async (app, token) => {
        const res = await app.request("/v1/wiki-pages?project=traceai", {
          headers: { Authorization: `Bearer ${token}` },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          items: Array<Record<string, unknown>>;
          total: number;
          limit: number;
          offset: number;
        };
        assert.equal(body.items.length, 2);
        assert.equal(body.total, 42, "total exposes what the slice hides");
        assert.equal(body.limit, 500);
        assert.equal(body.offset, 0);
        for (const item of body.items) {
          assert.ok(!("body" in item), "listing must not carry Markdown bodies");
          assert.ok(item.slug && item.title);
          assert.equal(item.parent, null);
        }
      },
    );
  });

  it("includes bodies when include_body=true", async () => {
    await withApp(
      async () => ({
        items: [wikiEntry("home")],
        total: 1,
        limit: 500,
        offset: 0,
      }),
      async (app, token) => {
        const res = await app.request(
          "/v1/wiki-pages?project=traceai&include_body=true",
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const body = (await res.json()) as {
          items: Array<Record<string, unknown>>;
        };
        assert.match(String(body.items[0]?.body), /long markdown body/);
      },
    );
  });

  it("forwards parent, limit and offset to the service", async () => {
    let seen: Record<string, unknown> | null = null;
    await withApp(
      async (input) => {
        seen = input as Record<string, unknown>;
        return { items: [], total: 0, limit: 10, offset: 20 };
      },
      async (app, token) => {
        await app.request(
          "/v1/wiki-pages?project=traceai&parent=design-packs&limit=10&offset=20",
          { headers: { Authorization: `Bearer ${token}` } },
        );
      },
    );
    assert.deepEqual(seen, {
      project: "traceai",
      parent: "design-packs",
      limit: 10,
      offset: 20,
    });
  });

  it("passes an empty parent through as root-only", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await withApp(
      async (input) => {
        seen.push(input as Record<string, unknown>);
        return { items: [], total: 0, limit: 500, offset: 0 };
      },
      async (app, token) => {
        await app.request("/v1/wiki-pages?project=traceai&parent=", {
          headers: { Authorization: `Bearer ${token}` },
        });
      },
    );
    assert.equal(seen[0]?.parent, "");
  });

  it("still rejects a missing project", async () => {
    await withApp(
      async () => {
        throw new Error("should not be called");
      },
      async (app, token) => {
        const res = await app.request("/v1/wiki-pages", {
          headers: { Authorization: `Bearer ${token}` },
        });
        assert.equal(res.status, 400);
      },
    );
  });
});
