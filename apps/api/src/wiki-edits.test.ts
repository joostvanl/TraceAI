import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, DEFAULT_AGENT_SCOPES } from "@traceai/auth";
import { AuroraApiError } from "@traceai/core";
import { createApp } from "./app.js";
import { projectMemberStubs } from "./test-support.js";

function wikiPage() {
  return {
    id: "id-page",
    slug: "ui-and-board",
    updatedAt: "2026-08-18T00:00:00.000Z",
    fields: {
      title: "UI & live board",
      body: "# UI & live board\n\n| Path | Purpose |\n",
      project: "traceai",
      parent: "engineering",
      sort_order: 3,
      updated_by: "agent",
    },
  };
}

/** Runs `fn` against an app whose service behaves like `updateWikiPage`. */
async function withApp(
  updateWikiPage: (slug: string, input: unknown) => Promise<unknown>,
  fn: (app: ReturnType<typeof createApp>, token: string) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "traceai-wiki-edits-"));
  const store = new AuthStore(join(dir, "auth.sqlite"));
  try {
    const user = store.createUser({ email: "e@example.com", name: "E" });
    const token = store.createToken({
      userId: user.id,
      name: "agent",
      scopes: [...DEFAULT_AGENT_SCOPES],
    });
    const app = createApp({
      authStore: store,
      service: {
        ...projectMemberStubs({ email: "e@example.com", projects: ["traceai"] }),
        // The route loads the page first: its project decides access (TRA-82).
        getWikiPage: async () => wikiPage(),
        updateWikiPage,
      } as never,
    });
    await fn(app, token.token);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function patch(
  app: ReturnType<typeof createApp>,
  token: string,
  body: unknown,
) {
  return app.request("/v1/wiki-pages/ui-and-board", {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const oneEdit = [{ old_string: "| Path | Purpose |", new_string: "| Path | Doel |" }];

describe("PATCH /v1/wiki-pages/:slug with edits (TRA-70)", () => {
  it("forwards edits to the service and reports applied_edits", async () => {
    const seen: unknown[] = [];
    await withApp(
      async (_slug, input) => {
        seen.push(input);
        return { page: wikiPage(), applied_edits: 1 };
      },
      async (app, token) => {
        const res = await patch(app, token, { edits: oneEdit });
        assert.equal(res.status, 200);
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(body.applied_edits, 1);
        assert.equal(body.slug, "ui-and-board");
      },
    );
    const input = seen[0] as { edits?: unknown[]; body?: unknown };
    assert.deepEqual(input.edits, oneEdit);
    assert.equal(input.body, undefined, "must not invent a full body write");
  });

  it("omits applied_edits on a plain body write (regression)", async () => {
    await withApp(
      async () => ({ page: wikiPage() }),
      async (app, token) => {
        const res = await patch(app, token, { body: "# new" });
        assert.equal(res.status, 200);
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(res.status, 200);
        assert.ok(!("applied_edits" in body));
      },
    );
  });

  it("rejects edits together with body", async () => {
    await withApp(
      async () => {
        throw new Error("service must not be called");
      },
      async (app, token) => {
        const res = await patch(app, token, { edits: oneEdit, body: "# new" });
        assert.equal(res.status, 400);
        const body = (await res.json()) as { code?: string };
        assert.equal(body.code, "VALIDATION");
      },
    );
  });

  it("rejects malformed edits before calling the service", async () => {
    const cases: unknown[] = [
      { edits: "nope" },
      { edits: [] },
      { edits: [{ old_string: "x" }] },
      { edits: [{ old_string: "", new_string: "y" }] },
      { edits: [{ old_string: "x", new_string: "y", replace_all: "yes" }] },
    ];
    for (const payload of cases) {
      await withApp(
        async () => {
          throw new Error("service must not be called");
        },
        async (app, token) => {
          const res = await patch(app, token, payload);
          assert.equal(res.status, 400, JSON.stringify(payload));
          const body = (await res.json()) as { code?: string };
          assert.equal(body.code, "VALIDATION");
        },
      );
    }
  });

  it("passes an Aurora 409 through as 409 with its issues", async () => {
    await withApp(
      async () => {
        throw new AuroraApiError("field_edits.body[0]: old_string not found", 409, {
          message: "field_edits.body[0]: old_string not found in field value",
          code: "CONFLICT",
          requestId: "req-1",
          issues: [
            {
              path: ["field_edits", "body", 0],
              code: "not_found",
              message: "old_string not found in field value",
            },
          ],
        });
      },
      async (app, token) => {
        const res = await patch(app, token, { edits: oneEdit });
        assert.equal(res.status, 409, "a stale anchor is a conflict, not a 500");
        const body = (await res.json()) as {
          code?: string;
          issues?: Array<{ code?: string }>;
          aurora_request_id?: string;
        };
        assert.equal(body.code, "CONFLICT");
        assert.equal(body.issues?.[0]?.code, "not_found");
        assert.equal(body.aurora_request_id, "req-1");
      },
    );
  });

  it("passes an Aurora 400 through as 400, not as a conflict", async () => {
    await withApp(
      async () => {
        throw new AuroraApiError('Field "sort_order" is not a string', 400, {
          message: 'Field "sort_order" is not a string (got number)',
          code: "VALIDATION_FAILED",
          issues: [
            {
              path: ["field_edits", "sort_order", 0],
              code: "invalid_field_edit",
            },
          ],
        });
      },
      async (app, token) => {
        const res = await patch(app, token, { edits: oneEdit });
        assert.equal(
          res.status,
          400,
          "re-reading cannot fix a bad request, so it must not look like 409",
        );
        const body = (await res.json()) as { code?: string };
        assert.equal(body.code, "VALIDATION_FAILED");
      },
    );
  });

  it("does not disguise an unexpected Aurora failure as a stale anchor", async () => {
    // Upstream outage must never look like 409, or an agent will re-read and
    // retry forever against a broken backend. TRA-79 maps Aurora 5xx to 502.
    await withApp(
      async () => {
        throw new AuroraApiError("Aurora API 503", 503, null);
      },
      async (app, token) => {
        const res = await patch(app, token, { edits: oneEdit });
        assert.equal(res.status, 502);
        const body = (await res.json()) as { code?: string };
        assert.equal(body.code, "BAD_GATEWAY");
        assert.notEqual(res.status, 409);
        assert.notEqual(res.status, 400);
      },
    );
  });
});
