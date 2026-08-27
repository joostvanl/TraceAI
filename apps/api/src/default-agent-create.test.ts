import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, DEFAULT_AGENT_SCOPES } from "@traceai/auth";
import { createApp } from "./app.js";
import { signHumanIdentity } from "./human-identity.js";
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
      defaultByProject?: Record<string, string | null>;
      projects?: string[];
      ticketProject?: string;
      saveCursorKey?: boolean;
      stage?: string;
      cursorStatus?: number;
      cursorBusy?: boolean;
      omitClaimedByUserId?: boolean;
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
      if (extras.saveCursorKey) {
        store.putAgentApiKey({
          userId: user.id,
          provider: "cursor",
          apiKey: "key_cursor_TEST",
          secret: SESSION_SECRET,
        });
      }
      const stage = extras.stage ?? "backlog";
      const ticketProject = extras.ticketProject ?? "traceai";
      const projects = extras.projects ?? ["traceai"];
      const defaultByProject =
        extras.defaultByProject ??
        (extras.defaultAgentId
          ? { [ticketProject]: extras.defaultAgentId }
          : undefined);
      const created = {
        id: "id-new",
        slug: "new-wish",
        fields: ticketFields({ stage, project: ticketProject }),
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
            projects,
            defaultByProject,
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
                // TRA-123: Aurora may persist the claim id but drop the claimer.
                claimed_by_user_id: extras.omitClaimedByUserId
                  ? ""
                  : (actorUserId ?? ""),
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

  it("nudges when claimTicket returns empty claimed_by_user_id (TRA-123)", async () => {
    await withCreateApp(
      {
        defaultAgentId: "bc-default-9",
        saveCursorKey: true,
        omitClaimedByUserId: true,
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
        assert.equal(res.status, 201, await res.clone().text());
        assert.equal(claimed.length, 1);
        await flush();
        assert.equal(followUps.length, 1);
        assert.equal(followUps[0]?.id, "bc-default-9");
        assert.match(followUps[0]?.prompt ?? "", /landed on backlog/i);
        assert.doesNotMatch(followUps[0]?.prompt ?? "", /Human verdict/);
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

  it("create in project A nudges A's membership default, not B's", async () => {
    await withCreateApp(
      {
        saveCursorKey: true,
        projects: ["alpha", "beta"],
        ticketProject: "alpha",
        defaultByProject: { alpha: "bc-alpha-1", beta: "bc-beta-9" },
      },
      async ({ app, token, followUps, claimed, flush }) => {
        const res = await app.request("/v1/tickets", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            project: "alpha",
            title: "Wish",
            description: "A short wish for the backlog",
          }),
        });
        assert.equal(res.status, 201, await res.clone().text());
        const body = (await res.json()) as { claimed_agent_id?: string | null };
        assert.equal(body.claimed_agent_id, "bc-alpha-1");
        assert.equal(claimed[0]?.agentId, "bc-alpha-1");
        await flush();
        assert.equal(followUps[0]?.id, "bc-alpha-1");
      },
    );
  });

  it("create in project B does not use A's membership default", async () => {
    await withCreateApp(
      {
        saveCursorKey: true,
        projects: ["alpha", "beta"],
        ticketProject: "beta",
        defaultByProject: { alpha: "bc-alpha-1", beta: "bc-beta-9" },
      },
      async ({ app, token, claimed, flush }) => {
        const res = await app.request("/v1/tickets", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            project: "beta",
            title: "Wish",
            description: "A short wish for the backlog",
          }),
        });
        assert.equal(res.status, 201, await res.clone().text());
        const body = (await res.json()) as { claimed_agent_id?: string | null };
        assert.equal(body.claimed_agent_id, "bc-beta-9");
        assert.equal(claimed[0]?.agentId, "bc-beta-9");
        await flush();
      },
    );
  });
});

describe("POST /v1/tickets default-agent live resolver (TRA-124)", () => {
  const PROXY_SECRET = "default-agent-proxy";
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

  it("nudges via Cursor fetch when Aurora omits claimed_by_user_id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-default-live-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    const jobs: Array<() => void> = [];
    const fetchCalls: Array<{ url: string; auth: string }> = [];
    try {
      const owner = store.createUser({
        email: "owner@example.com",
        name: "Owner",
      });
      const token = store.createToken({
        userId: owner.id,
        name: "agent",
        scopes: [...DEFAULT_AGENT_SCOPES],
      });
      store.putAgentApiKey({
        userId: owner.id,
        provider: "cursor",
        apiKey: "key_owner_live_1111",
        secret: SESSION_SECRET,
      });
      const created = {
        id: "id-live",
        slug: "live-wish",
        fields: ticketFields(),
      };
      const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        fetchCalls.push({
          url: String(url),
          auth: String(
            (init?.headers as Record<string, string> | undefined)?.Authorization,
          ),
        });
        return new Response("{}", { status: 201 });
      }) as typeof fetch;
      const app = createApp({
        authStore: store,
        nudgeQueue: null,
        scheduleWakeup: (fn) => jobs.push(fn),
        cursorCloudFetch: fetchImpl,
        service: {
          ...projectMemberStubs({
            email: "owner@example.com",
            projects: ["traceai"],
            defaultByProject: { traceai: "bc-live-1" },
          }),
          getWorkflow: async () => ({
            workflow: { slug: "traceai-traceai-story" },
            stages: [
              { key: "backlog", name: "Backlog", transitions: ["in_refinement"] },
            ],
            workflow_document: { version: 1, stages: [] },
          }),
          createTicket: async () => created,
          claimTicket: async (slug: string, agentId: string) => ({
            ...created,
            fields: {
              ...created.fields,
              claimed_agent_id: agentId,
              claimed_by_user_id: "",
            },
          }),
        } as never,
      });
      const res = await app.request("/v1/tickets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          project: "traceai",
          title: "Wish",
          description: "A short wish for the backlog",
        }),
      });
      assert.equal(res.status, 201, await res.clone().text());
      const body = (await res.json()) as { claimed_agent_id?: string | null };
      assert.equal(body.claimed_agent_id, "bc-live-1");
      for (const job of jobs) job();
      await new Promise((r) => setImmediate(r));
      assert.equal(fetchCalls.length, 1);
      assert.match(fetchCalls[0]?.url ?? "", /bc-live-1/);
      const expectedAuth = Buffer.from("key_owner_live_1111:", "utf8").toString(
        "base64",
      );
      assert.match(fetchCalls[0]?.auth ?? "", new RegExp(expectedAuth));
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("UI human-proxy create uses the personal user's key, not the BFF token user", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-default-ui-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    const jobs: Array<() => void> = [];
    const fetchCalls: Array<{ url: string; auth: string }> = [];
    try {
      const bff = store.createUser({
        email: "bff@example.com",
        name: "BFF",
      });
      const person = store.createUser({
        email: "ui+alice@users.traceai.local",
        name: "Alice",
      });
      const token = store.createToken({
        userId: bff.id,
        name: "web",
        scopes: [...DEFAULT_AGENT_SCOPES],
      });
      store.putAgentApiKey({
        userId: person.id,
        provider: "cursor",
        apiKey: "key_alice_ui_9999",
        secret: SESSION_SECRET,
      });
      store.putAgentApiKey({
        userId: bff.id,
        provider: "cursor",
        apiKey: "key_bff_must_not_win",
        secret: SESSION_SECRET,
      });
      const created = {
        id: "id-ui",
        slug: "ui-wish",
        fields: ticketFields(),
      };
      const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        fetchCalls.push({
          url: String(url),
          auth: String(
            (init?.headers as Record<string, string> | undefined)?.Authorization,
          ),
        });
        return new Response("{}", { status: 201 });
      }) as typeof fetch;
      const app = createApp({
        authStore: store,
        nudgeQueue: null,
        scheduleWakeup: (fn) => jobs.push(fn),
        cursorCloudFetch: fetchImpl,
        service: {
          ...projectMemberStubs({
            email: "bff@example.com",
            userSlug: "bff",
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
          listProjectMemberships: async () => [
            {
              id: "id-traceai-bff",
              slug: "traceai-member-bff",
              fields: { project: "traceai", user: "bff", role: "admin" as const },
            },
            {
              id: "id-traceai-alice",
              slug: "traceai-member-alice",
              fields: {
                project: "traceai",
                user: "alice",
                role: "admin" as const,
                default_cursor_agent_id: "bc-alice-9",
              },
            },
          ],
          getOwnMembershipDefaultAgent: async (
            project: string,
            user: string,
          ) =>
            project === "traceai" && user === "alice" ? "bc-alice-9" : null,
          getWorkflow: async () => ({
            workflow: { slug: "traceai-traceai-story" },
            stages: [
              { key: "backlog", name: "Backlog", transitions: ["in_refinement"] },
            ],
            workflow_document: { version: 1, stages: [] },
          }),
          createTicket: async () => created,
          claimTicket: async (_slug: string, agentId: string) => ({
            ...created,
            fields: {
              ...created.fields,
              claimed_agent_id: agentId,
              claimed_by_user_id: "",
            },
          }),
        } as never,
      });
      const res = await app.request("/v1/tickets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
          "x-traceai-human-proxy": PROXY_SECRET,
          "x-traceai-human-identity": signHumanIdentity(
            {
              user: "alice",
              slug: "alice",
              display_name: "Alice",
              is_platform_admin: false,
              mode: "personal",
            },
            SESSION_SECRET,
          ),
        },
        body: JSON.stringify({
          project: "traceai",
          title: "Wish",
          description: "A short wish for the backlog",
        }),
      });
      assert.equal(res.status, 201, await res.clone().text());
      for (const job of jobs) job();
      await new Promise((r) => setImmediate(r));
      assert.equal(fetchCalls.length, 1);
      assert.match(fetchCalls[0]?.url ?? "", /bc-alice-9/);
      const aliceAuth = Buffer.from("key_alice_ui_9999:", "utf8").toString(
        "base64",
      );
      const bffAuth = Buffer.from("key_bff_must_not_win:", "utf8").toString(
        "base64",
      );
      assert.match(fetchCalls[0]?.auth ?? "", new RegExp(aliceAuth));
      assert.doesNotMatch(fetchCalls[0]?.auth ?? "", new RegExp(bffAuth));
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
