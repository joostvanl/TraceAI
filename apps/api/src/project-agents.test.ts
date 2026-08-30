import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, DEFAULT_AGENT_SCOPES } from "@traceai/auth";
import {
  ConflictError,
  assertUniqueProjectAgentDisplayName,
  parseClaimedAgentId,
  trimDisplayName,
  claimedAgentLabel,
} from "@traceai/core";
import { createApp } from "./app.js";
import { projectMemberStubs } from "./test-support.js";
import { signHumanIdentity } from "./human-identity.js";

const PROXY_SECRET = "project-agents-proxy";
const SESSION_SECRET = "project-agents-session-secret";

type AgentRow = {
  id: string;
  slug: string;
  fields: {
    project: string;
    cursor_agent_id: string;
    display_name: string;
  };
};

function memoryAgents() {
  const rows: AgentRow[] = [];
  let n = 0;
  return {
    rows,
    listProjectAgents: async (project: string) =>
      rows.filter((row) => row.fields.project === project),
    upsertProjectAgent: async (input: {
      project: string;
      cursor_agent_id: string;
      display_name?: string | null;
    }) => {
      const parsed = parseClaimedAgentId(input.cursor_agent_id);
      if (!parsed.ok) throw new Error(parsed.message);
      if (!parsed.value) throw new Error("cursor_agent_id is required");
      const displayName = trimDisplayName(input.display_name);
      const scoped = rows.filter((row) => row.fields.project === input.project);
      assertUniqueProjectAgentDisplayName({
        agents: scoped.map((row) => row.fields),
        cursorAgentId: parsed.value,
        displayName,
      });
      const match = rows.find(
        (row) =>
          row.fields.project === input.project &&
          row.fields.cursor_agent_id === parsed.value,
      );
      if (match) {
        match.fields.display_name = displayName;
        return match;
      }
      n += 1;
      const created: AgentRow = {
        id: `id-agent-${n}`,
        slug: `${input.project}-agent-${parsed.value}`,
        fields: {
          project: input.project,
          cursor_agent_id: parsed.value,
          display_name: displayName,
        },
      };
      rows.push(created);
      return created;
    },
  };
}

function ticketEntry(input: {
  slug: string;
  project?: string;
  claimed_agent_id?: string;
}) {
  return {
    slug: input.slug,
    fields: {
      title: input.slug,
      project: input.project ?? "traceai",
      workflow: "traceai-traceai-story",
      stage: "in_progress",
      claimed_agent_id: input.claimed_agent_id ?? "",
      claimed_by_user_id: "",
    },
  };
}

async function withApp(
  extra: Record<string, unknown>,
  fn: (app: ReturnType<typeof createApp>, token: string) => Promise<void>,
  options: {
    email?: string;
    projects?: string[];
    role?: "admin" | "editor" | "viewer";
    enforceRoles?: boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "traceai-project-agents-"));
  const store = new AuthStore(join(dir, "auth.sqlite"));
  const email = options.email ?? "alice@users.traceai.local";
  try {
    const user = store.createUser({ email, name: "Alice" });
    const token = store.createToken({
      userId: user.id,
      name: "agent",
      scopes: [...DEFAULT_AGENT_SCOPES],
    });
    const app = createApp({
      authStore: store,
      service: {
        ...projectMemberStubs({
          email,
          userSlug: "alice",
          projects: options.projects ?? ["traceai"],
          role: options.role,
          enforceRoles: options.enforceRoles,
        }),
        getProject: async (slug: string) =>
          slug === "traceai" || slug === "other"
            ? { project: { slug, fields: { name: slug } }, stages: [] }
            : null,
        ...extra,
      } as never,
    });
    await fn(app, token.token);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

describe("GET/PUT /v1/projects/:slug/agents (TRA-127)", () => {
  const prevProxy = process.env.TRACEAI_HUMAN_PROXY_SECRET;
  const prevSession = process.env.TRACEAI_SESSION_SECRET;

  before(() => {
    process.env.TRACEAI_HUMAN_PROXY_SECRET = PROXY_SECRET;
    process.env.TRACEAI_SESSION_SECRET = SESSION_SECRET;
  });

  after(() => {
    if (prevProxy === undefined) delete process.env.TRACEAI_HUMAN_PROXY_SECRET;
    else process.env.TRACEAI_HUMAN_PROXY_SECRET = prevProxy;
    if (prevSession === undefined) delete process.env.TRACEAI_SESSION_SECRET;
    else process.env.TRACEAI_SESSION_SECRET = prevSession;
  });

  it("stores a weergavenaam, unique per project, empty name valid, no rebind", async () => {
    const agents = memoryAgents();
    await withApp(agents, async (app, token) => {
      const headers = authHeaders(token);
      const created = await app.request("/v1/projects/traceai/agents", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          cursor_agent_id: "bc-old",
          display_name: "Henk",
        }),
      });
      assert.equal(created.status, 200, await created.clone().text());
      const createdBody = (await created.json()) as { display_name: string };
      assert.equal(createdBody.display_name, "Henk");

      const clash = await app.request("/v1/projects/traceai/agents", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          cursor_agent_id: "bc-other",
          display_name: "henk",
        }),
      });
      assert.equal(clash.status, 409);
      const clashBody = (await clash.json()) as { code?: string };
      assert.equal(clashBody.code, "AGENT_DISPLAY_NAME_CONFLICT");

      const empty = await app.request("/v1/projects/traceai/agents", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          cursor_agent_id: "bc-new",
          display_name: "",
        }),
      });
      assert.equal(empty.status, 200, await empty.clone().text());
      const emptyBody = (await empty.json()) as {
        cursor_agent_id: string;
        display_name: string;
      };
      assert.equal(emptyBody.cursor_agent_id, "bc-new");
      assert.equal(emptyBody.display_name, "");

      const listed = await app.request("/v1/projects/traceai/agents", {
        headers,
      });
      assert.equal(listed.status, 200);
      const listBody = (await listed.json()) as {
        items: Array<{ cursor_agent_id: string; display_name: string }>;
      };
      const byId = Object.fromEntries(
        listBody.items.map((row) => [row.cursor_agent_id, row.display_name]),
      );
      assert.equal(byId["bc-old"], "Henk");
      assert.equal(byId["bc-new"], "");
      assert.equal(byId["bc-other"], undefined);
    });
  });

  it("allows the same name in another project", async () => {
    const agents = memoryAgents();
    await withApp(
      agents,
      async (app, token) => {
        const headers = authHeaders(token);
        const a = await app.request("/v1/projects/traceai/agents", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            cursor_agent_id: "bc-1",
            display_name: "Henk",
          }),
        });
        assert.equal(a.status, 200, await a.clone().text());
        const b = await app.request("/v1/projects/other/agents", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            cursor_agent_id: "bc-2",
            display_name: "Henk",
          }),
        });
        assert.equal(b.status, 200, await b.clone().text());
      },
      { projects: ["traceai", "other"] },
    );
  });

  it("GET ticket and list expose Henk when mapped, else truncated fallback", async () => {
    const agents = memoryAgents();
    agents.rows.push({
      id: "id-henk",
      slug: "traceai-agent-bc-henk",
      fields: {
        project: "traceai",
        cursor_agent_id: "bc-abcdefghijklmno",
        display_name: "Henk",
      },
    });
    await withApp(
      {
        ...agents,
        listTickets: async () => [
          ticketEntry({
            slug: "named",
            claimed_agent_id: "bc-abcdefghijklmno",
          }),
          ticketEntry({
            slug: "fallback",
            claimed_agent_id: "bc-zzzzzzzzzzzzzzz",
          }),
          ticketEntry({ slug: "open", claimed_agent_id: "" }),
        ],
        getTicket: async (slug: string) => {
          const tickets = [
            ticketEntry({
              slug: "named",
              claimed_agent_id: "bc-abcdefghijklmno",
            }),
            ticketEntry({
              slug: "fallback",
              claimed_agent_id: "bc-zzzzzzzzzzzzzzz",
            }),
          ];
          const ticket = tickets.find((t) => t.slug === slug);
          if (!ticket) return null;
          return {
            ticket,
            comments: [],
            children: [],
            parent_ticket: null,
            tokens_estimate_rollup: 0,
            tokens_actual_rollup: 0,
          };
        },
      },
      async (app, token) => {
        const headers = authHeaders(token);
        const list = await app.request("/v1/tickets?project=traceai", {
          headers,
        });
        assert.equal(list.status, 200, await list.clone().text());
        const rows = (await list.json()) as Array<{
          slug: string;
          claimed_agent_display_name: string | null;
          claimed_agent_id: string | null;
        }>;
        const named = rows.find((r) => r.slug === "named");
        const fallback = rows.find((r) => r.slug === "fallback");
        const open = rows.find((r) => r.slug === "open");
        assert.equal(named?.claimed_agent_display_name, "Henk");
        assert.equal(fallback?.claimed_agent_display_name, null);
        assert.equal(open?.claimed_agent_display_name, null);
        assert.equal(
          claimedAgentLabel(
            named?.claimed_agent_id,
            named?.claimed_agent_display_name,
          ),
          "Henk",
        );
        assert.equal(
          claimedAgentLabel(
            fallback?.claimed_agent_id,
            fallback?.claimed_agent_display_name,
          ),
          "Cursor Cloud bc-zzzzzzzzz…",
        );
        assert.equal(
          claimedAgentLabel(open?.claimed_agent_id, open?.claimed_agent_display_name),
          null,
        );

        const detail = await app.request("/v1/tickets/named", { headers });
        assert.equal(detail.status, 200);
        const body = (await detail.json()) as {
          claimed_agent_display_name: string | null;
        };
        assert.equal(body.claimed_agent_display_name, "Henk");
      },
    );
  });

  it("viewer PUT is 403", async () => {
    const agents = memoryAgents();
    await withApp(
      agents,
      async (app, token) => {
        const headers = {
          ...authHeaders(token),
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
        };
        const res = await app.request("/v1/projects/traceai/agents", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            cursor_agent_id: "bc-viewer-1",
            display_name: "Henk",
          }),
        });
        assert.equal(res.status, 403, await res.clone().text());
      },
      { role: "viewer", enforceRoles: true },
    );
  });

  it("non-members cannot read project agents (404, not 403)", async () => {
    const agents = memoryAgents();
    await withApp(
      agents,
      async (app, token) => {
        const res = await app.request("/v1/projects/secret-project/agents", {
          headers: authHeaders(token),
        });
        assert.equal(res.status, 404);
        const body = (await res.json()) as { code?: string };
        assert.equal(body.code, "NOT_FOUND");
      },
      { projects: ["traceai"] },
    );
  });

  it("legacy login cannot read project agents beyond the member gate", async () => {
    const agents = memoryAgents();
    await withApp(agents, async (app, token) => {
      const headers = {
        ...authHeaders(token),
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
      };
      const res = await app.request("/v1/projects/traceai/agents", { headers });
      // Legacy has no membership slug; existing project gate is 404.
      assert.equal(res.status, 404);
    });
  });

  it("upsert ConflictError maps to HTTP 409", async () => {
    await withApp(
      {
        listProjectAgents: async () => [],
        upsertProjectAgent: async () => {
          throw new ConflictError(
            "display_name already used in this project",
            "AGENT_DISPLAY_NAME_CONFLICT",
          );
        },
      },
      async (app, token) => {
        const res = await app.request("/v1/projects/traceai/agents", {
          method: "PUT",
          headers: authHeaders(token),
          body: JSON.stringify({
            cursor_agent_id: "bc-1",
            display_name: "Henk",
          }),
        });
        assert.equal(res.status, 409);
      },
    );
  });
});
