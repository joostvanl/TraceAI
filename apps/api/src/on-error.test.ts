import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, DEFAULT_AGENT_SCOPES } from "@traceai/auth";
import {
  AuroraApiError,
  AuroraNetworkError,
  NotFoundError,
  ValidationError,
} from "@traceai/core";
import { createApp } from "./app.js";
import { projectMemberStubs } from "./test-support.js";

async function withApp(
  service: Record<string, unknown>,
  fn: (app: ReturnType<typeof createApp>, token: string) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "traceai-on-error-"));
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
        ...service,
      } as never,
    });
    await fn(app, token.token);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function jsonBody(res: Response) {
  return (await res.json()) as { message?: string; code?: string };
}

describe("onError typed mapping (TRA-79)", () => {
  it("A1: bare Error → 500 INTERNAL, not 400", async () => {
    await withApp(
      {
        searchProject: async () => {
          throw new Error("boom");
        },
      },
      async (app, token) => {
        const res = await app.request("/v1/projects/traceai/search", {
          headers: authHeaders(token),
        });
        assert.equal(res.status, 500);
        const body = await jsonBody(res);
        assert.equal(body.code, "INTERNAL");
        assert.equal(body.message, "boom");
        assert.notEqual(res.status, 400);
      },
    );
  });

  it("A2: Error whose text contains 'not found' → 500, not 404", async () => {
    await withApp(
      {
        searchProject: async () => {
          throw new Error("resource not found");
        },
      },
      async (app, token) => {
        const res = await app.request("/v1/projects/traceai/search", {
          headers: authHeaders(token),
        });
        assert.equal(res.status, 500);
        const body = await jsonBody(res);
        assert.equal(body.code, "INTERNAL");
        assert.notEqual(res.status, 404);
      },
    );
  });

  it("A3: NotFoundError → 404 NOT_FOUND", async () => {
    await withApp(
      {
        searchProject: async () => {
          throw new NotFoundError("Wiki page not found: x");
        },
      },
      async (app, token) => {
        const res = await app.request("/v1/projects/traceai/search", {
          headers: authHeaders(token),
        });
        assert.equal(res.status, 404);
        const body = await jsonBody(res);
        assert.equal(body.code, "NOT_FOUND");
        assert.equal(body.message, "Wiki page not found: x");
      },
    );
  });

  it("A4: ValidationError with 'not allowed' → 400, not 403", async () => {
    await withApp(
      {
        transitionTicket: async () => {
          throw new ValidationError(
            'Transition from "todo" to "done" is not allowed',
          );
        },
        getTicket: async () => ({
          ticket: {
            id: "id-t",
            slug: "demo-ticket",
            fields: {
              title: "Demo",
              project: "traceai",
              workflow: "standard-worker",
              stage: "todo",
            },
          },
        }),
      },
      async (app, token) => {
        const res = await app.request("/v1/tickets/demo-ticket/transition", {
          method: "POST",
          headers: {
            ...authHeaders(token),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            to_stage: "done",
            comment:
              "## Vorige stap\nWas in todo.\n\n## Deze stap\nMoving to done.",
          }),
        });
        assert.equal(res.status, 400);
        const body = await jsonBody(res);
        assert.equal(body.code, "VALIDATION");
        assert.notEqual(res.status, 403);
      },
    );
  });

  it("A5: AuroraApiError 503 on a route without its own catch → 502 BAD_GATEWAY", async () => {
    await withApp(
      {
        searchProject: async () => {
          throw new AuroraApiError("Aurora API 503", 503, null);
        },
      },
      async (app, token) => {
        const res = await app.request("/v1/projects/traceai/search", {
          headers: authHeaders(token),
        });
        assert.equal(res.status, 502);
        const body = await jsonBody(res);
        assert.equal(body.code, "BAD_GATEWAY");
      },
    );
  });

  it("A5b: AuroraNetworkError → 502 BAD_GATEWAY", async () => {
    await withApp(
      {
        searchProject: async () => {
          throw new AuroraNetworkError("Aurora network error: fetch failed");
        },
      },
      async (app, token) => {
        const res = await app.request("/v1/projects/traceai/search", {
          headers: authHeaders(token),
        });
        assert.equal(res.status, 502);
        const body = await jsonBody(res);
        assert.equal(body.code, "BAD_GATEWAY");
      },
    );
  });

  it("A8: GET unknown wiki slug → 404 NOT_FOUND, not 500", async () => {
    await withApp(
      {
        getWikiPage: async () => null,
      },
      async (app, token) => {
        const res = await app.request("/v1/wiki-pages/missing-page", {
          headers: authHeaders(token),
        });
        assert.equal(res.status, 404);
        const body = await jsonBody(res);
        assert.equal(body.code, "NOT_FOUND");
        assert.notEqual(res.status, 500);
      },
    );
  });

  it("A8b: PATCH wiki whose service throws NotFoundError → 404, not 500", async () => {
    await withApp(
      {
        getWikiPage: async () => ({
          id: "id-page",
          slug: "missing-page",
          fields: { title: "X", body: "", project: "traceai", parent: null },
        }),
        updateWikiPage: async () => {
          throw new NotFoundError("Wiki page not found: missing-page");
        },
      },
      async (app, token) => {
        const res = await app.request("/v1/wiki-pages/missing-page", {
          method: "PATCH",
          headers: {
            ...authHeaders(token),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ title: "Y" }),
        });
        assert.equal(res.status, 404);
        const body = await jsonBody(res);
        assert.equal(body.code, "NOT_FOUND");
        assert.notEqual(res.status, 500);
      },
    );
  });

  it("A9: GET unknown ticket slug (handler 404) stays 404, not 500", async () => {
    await withApp(
      {
        getTicket: async () => null,
      },
      async (app, token) => {
        const res = await app.request("/v1/tickets/missing-ticket", {
          headers: authHeaders(token),
        });
        assert.equal(res.status, 404);
        const body = await jsonBody(res);
        assert.equal(body.code, "NOT_FOUND");
        assert.notEqual(res.status, 500);
      },
    );
  });

  it("A9b: ticket write whose service throws Ticket not found → 404, not 500", async () => {
    await withApp(
      {
        getTicket: async () => ({
          ticket: {
            id: "id-t",
            slug: "missing-ticket",
            fields: { title: "X", project: "traceai", stage: "todo" },
          },
        }),
        updateTicket: async () => {
          throw new NotFoundError("Ticket not found: missing-ticket");
        },
      },
      async (app, token) => {
        const res = await app.request("/v1/tickets/missing-ticket", {
          method: "PATCH",
          headers: {
            ...authHeaders(token),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ title: "Y" }),
        });
        assert.equal(res.status, 404);
        const body = await jsonBody(res);
        assert.equal(body.code, "NOT_FOUND");
        assert.notEqual(res.status, 500);
      },
    );
  });

  it("A10: search on unknown project (service NotFoundError) → 404, not 500", async () => {
    await withApp(
      {
        searchProject: async () => {
          throw new NotFoundError("Project not found: missing-project");
        },
      },
      async (app, token) => {
        const res = await app.request("/v1/projects/missing-project/search", {
          headers: authHeaders(token),
        });
        assert.equal(res.status, 404);
        const body = await jsonBody(res);
        assert.equal(body.code, "NOT_FOUND");
        assert.notEqual(res.status, 500);
      },
    );
  });

  it("A10b: history on unknown project → 404, not 500", async () => {
    await withApp(
      {
        listTicketHistory: async () => {
          throw new NotFoundError("Project not found: missing-project");
        },
      },
      async (app, token) => {
        const res = await app.request("/v1/projects/missing-project/history", {
          headers: authHeaders(token),
        });
        assert.equal(res.status, 404);
        const body = await jsonBody(res);
        assert.equal(body.code, "NOT_FOUND");
        assert.notEqual(res.status, 500);
      },
    );
  });
});
