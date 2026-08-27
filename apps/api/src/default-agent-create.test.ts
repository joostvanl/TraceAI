import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, DEFAULT_AGENT_SCOPES } from "@traceai/auth";
import { createApp } from "./app.js";
import { projectMemberStubs } from "./test-support.js";

const SESSION_SECRET = "default-agent-session";

function ticketFields(overrides: Record<string, unknown> = {}) {
  return {
    title: "Wish",
    description: "A short wish for the backlog",
    project: "traceai",
    workflow: "traceai-traceai-story",
    stage: "backlog",
    priority: "medium",
    ticket_key: "TRA-122",
    ticket_number: 122,
    tokens_estimate: null,
    tokens_actual: null,
    resolution: null,
    review_state: null,
    parent: null,
    sort_order: 0,
    claimed_agent_id: "",
    claimed_by_user_id: "",
    ...overrides,
  };
}

describe("POST /v1/tickets default-agent nudge (TRA-122)", () => {
  const prevSession = process.env.TRACEAI_SESSION_SECRET;
  const prevAgent = process.env.TRACEAI_AGENT_API_SECRET;

  before(() => {
    process.env.TRACEAI_SESSION_SECRET = SESSION_SECRET;
    delete process.env.TRACEAI_AGENT_API_SECRET;
  });

  after(() => {
    if (prevSession === undefined) delete process.env.TRACEAI_SESSION_SECRET;
    else process.env.TRACEAI_SESSION_SECRET = prevSession;
    if (prevAgent === undefined) delete process.env.TRACEAI_AGENT_API_SECRET;
    else process.env.TRACEAI_AGENT_API_SECRET = prevAgent;
  });

  async function withCreateApp(
    extras: {
      defaultAgentId?: string | null;
      saveCursorKey?: boolean;
      stage?: string;
      cursorStatus?: number;
      cursorBusy?: boolean;
    },
    fn: (input: {
      app: ReturnType<typeof createApp>;
      token: string;
      followUps: Array<{ id: string; prompt: string }>;
      claimed: Array<{ slug: string; agentId: string; actorUserId: string }>;
      flush: () => Promise<void>;
    }) => Promise<void>,
  ) {
    const dir = mkdtempSync(join(tmpdir(), "traceai-default-create-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    const jobs: Array<() => void> = [];
    const followUps: Array<{ id: string; prompt: string }> = [];
    const claimed: Array<{
      slug: string;
      agentId: string;
      actorUserId: string;
    }> = [];
    try {
      const user = store.createUser({
        email: "owner@example.com",
        name: "Owner",
      });
      const token = store.createToken({
        userId: user.id,
        name: "agent",
        scopes: [...DEFAULT_AGENT_SCOPES],
      });
      if (extras.defaultAgentId) {
        store.setDefaultCursorAgentId(user.id, extras.defaultAgentId);
      }
      if (extras.saveCursorKey) {
        store.putAgentApiKey({
          userId: user.id,
          provider: "cursor",
          apiKey: "key_cursor_TEST",
          secret: SESSION_SECRET,
        });
      }
      const stage = extras.stage ?? "backlog";
      const created = {
        id: "id-new",
        slug: "new-wish",
        fields: ticketFields({ stage }),
      };
      const app = createApp({
        authStore: store,
        nudgeQueue: null,
        scheduleWakeup: (fn) => jobs.push(fn),
        cursorCloud: {
          followUp: async (id, prompt) => {
            followUps.push({ id, prompt });
            const status = extras.cursorStatus ?? 201;
            return {
              ok: status >= 200 && status < 300,
              status,
              busy: extras.cursorBusy === true,
            };
          },
        },
        service: {
          ...projectMemberStubs({
            email: "owner@example.com",
            projects: ["traceai"],
          }),
          getWorkflow: async () => ({
            workflow: { slug: "traceai-traceai-story" },
            stages: [
              { key: "backlog", name: "Backlog", transitions: ["in_refinement"] },
              { key: "todo", name: "To do", transitions: ["in_progress"] },
            ],
            workflow_document: { version: 1, stages: [] },
          }),
          createTicket: async () => created,
          claimTicket: async (
            slug: string,
            agentId: string,
            actorUserId?: string | null,
          ) => {
            claimed.push({
              slug,
              agentId,
              actorUserId: actorUserId ?? "",
            });
            return {
              ...created,
              fields: {
                ...created.fields,
                claimed_agent_id: agentId,
                claimed_by_user_id: actorUserId ?? "",
              },
            };
          },
        } as never,
      });
      await fn({
        app,
        token: token.token,
        followUps,
        claimed,
        flush: async () => {
          for (const job of jobs) job();
          await new Promise((r) => setImmediate(r));
        },
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("claims and nudges the default bc- agent when create lands on Backlog", async () => {
    await withCreateApp(
      { defaultAgentId: "bc-default-9", saveCursorKey: true },
      async ({ app, token, followUps, claimed, flush }) => {
        const res = await app.request("/v1/tickets", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            project: "traceai",
            title: "Wish",
            description: "A short wish for the backlog",
          }),
        });
        assert.equal(res.status, 201, await res.clone().text());
        const body = (await res.json()) as {
          claimed_agent_id?: string | null;
        };
        assert.equal(body.claimed_agent_id, "bc-default-9");
        assert.equal(claimed.length, 1);
        assert.equal(claimed[0]?.slug, "new-wish");
        assert.equal(claimed[0]?.agentId, "bc-default-9");
        assert.ok((claimed[0]?.actorUserId.length ?? 0) > 0);
        await flush();
        assert.equal(followUps.length, 1);
        assert.equal(followUps[0]?.id, "bc-default-9");
        assert.match(followUps[0]?.prompt ?? "", /landed on backlog/i);
        assert.doesNotMatch(followUps[0]?.prompt ?? "", /Human verdict/);
      },
    );
  });

  it("does not claim or call Cursor without a default id", async () => {
    await withCreateApp(
      { saveCursorKey: true },
      async ({ app, token, followUps, claimed, flush }) => {
        const res = await app.request("/v1/tickets", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            project: "traceai",
            title: "Wish",
            description: "A short wish for the backlog",
          }),
        });
        assert.equal(res.status, 201);
        const body = (await res.json()) as {
          claimed_agent_id?: string | null;
        };
        assert.equal(body.claimed_agent_id, null);
        assert.deepEqual(claimed, []);
        await flush();
        assert.deepEqual(followUps, []);
      },
    );
  });

  it("does not claim without a Cursor key", async () => {
    await withCreateApp(
      { defaultAgentId: "bc-default-9", saveCursorKey: false },
      async ({ app, token, followUps, claimed, flush }) => {
        const res = await app.request("/v1/tickets", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            project: "traceai",
            title: "Wish",
            description: "A short wish for the backlog",
          }),
        });
        assert.equal(res.status, 201);
        assert.deepEqual(claimed, []);
        await flush();
        assert.deepEqual(followUps, []);
      },
    );
  });

  it("does not nudge when create is not the first workflow stage", async () => {
    await withCreateApp(
      {
        defaultAgentId: "bc-default-9",
        saveCursorKey: true,
        stage: "todo",
      },
      async ({ app, token, followUps, claimed, flush }) => {
        const res = await app.request("/v1/tickets", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            project: "traceai",
            title: "Wish",
            description: "A short wish for the backlog",
            stage: "todo",
          }),
        });
        assert.equal(res.status, 201);
        assert.deepEqual(claimed, []);
        await flush();
        assert.deepEqual(followUps, []);
      },
    );
  });

  it("stores a non-bc default but does not nudge it", async () => {
    await withCreateApp(
      { defaultAgentId: "local-agent", saveCursorKey: true },
      async ({ app, token, followUps, claimed, flush }) => {
        const res = await app.request("/v1/tickets", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            project: "traceai",
            title: "Wish",
            description: "A short wish for the backlog",
          }),
        });
        assert.equal(res.status, 201);
        assert.deepEqual(claimed, []);
        await flush();
        assert.deepEqual(followUps, []);
      },
    );
  });

  it("still returns 201 when Cursor returns 500", async () => {
    await withCreateApp(
      {
        defaultAgentId: "bc-default-9",
        saveCursorKey: true,
        cursorStatus: 500,
      },
      async ({ app, token, followUps, claimed, flush }) => {
        const res = await app.request("/v1/tickets", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            project: "traceai",
            title: "Wish",
            description: "A short wish for the backlog",
          }),
        });
        assert.equal(res.status, 201);
        assert.equal(claimed.length, 1);
        await flush();
        assert.equal(followUps.length, 1);
      },
    );
  });
});
