import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, DEFAULT_AGENT_SCOPES } from "@traceai/auth";
import { LIVE_BOARD_ACTIVITY_INSTRUCTION } from "@traceai/core";
import { createApp } from "./app.js";
import { signHumanIdentity } from "./human-identity.js";
import { projectMemberStubs } from "./test-support.js";

const PROXY_SECRET = "live-board-activity-proxy";
const SESSION_SECRET = "live-board-activity-session";
const SUMMARY = "Keep each ticket as a thin executable playbook.";

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

const policy = { summary: SUMMARY, on_every_transition: [] as string[] };
const document = { version: 1, agent_policy: policy, stages: [] };

describe("live-board-activity toggle (TRA-142)", () => {
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
      flags: Map<string, boolean>;
    }) => Promise<void>,
    extras: {
      role?: "admin" | "editor" | "viewer";
      enforceRoles?: boolean;
      enabled?: boolean;
    } = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), "traceai-live-board-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    try {
      const userSlug = "alice";
      const user = store.createUser({
        email: "ui+alice@users.traceai.local",
        name: userSlug,
      });
      const token = store.createToken({
        userId: user.id,
        name: "web",
        scopes: [...DEFAULT_AGENT_SCOPES],
      });
      const flags = new Map<string, boolean>([
        ["traceai", extras.enabled === true],
      ]);
      const stubs = projectMemberStubs({
        email: "ui+alice@users.traceai.local",
        userSlug,
        projects: ["traceai"],
        role: extras.role ?? "admin",
        enforceRoles: extras.enforceRoles,
      });
      const app = createApp({
        authStore: store,
        service: {
          ...stubs,
          getProjectLiveBoardActivity: async (project: string) =>
            flags.get(project) === true,
          setProjectLiveBoardActivity: async (args: {
            project: string;
            enabled: boolean;
          }) => {
            flags.set(args.project, args.enabled);
            return args.enabled;
          },
          getProject: async (slug: string) => {
            if (slug !== "traceai") return null;
            return {
              project: {
                slug: "traceai",
                fields: {
                  name: "TraceAI",
                  require_live_board_activity: flags.get("traceai")
                    ? "true"
                    : "",
                },
              },
              workflow: {
                slug: "traceai-traceai-story",
                fields: { name: "Story", project: "traceai" },
              },
              stages: [],
              workflow_document: document,
            };
          },
          getWorkflow: async (slug: string) => {
            if (slug !== "traceai-traceai-story") return null;
            return {
              workflow: {
                slug,
                fields: { name: "Story", project: "traceai" },
              },
              stages: [],
              workflow_document: document,
            };
          },
          getTraceaiUser: async (slug: string) =>
            slug === userSlug
              ? {
                  id: `id-${userSlug}`,
                  slug: userSlug,
                  fields: {
                    username: userSlug,
                    display_name: userSlug,
                    status: "active",
                    is_platform_admin: false,
                  },
                }
              : null,
        } as never,
        cursorCloud: null,
      });
      await fn({ app, token: token.token, flags });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("GET/PUT persist the toggle; viewer cannot write", async () => {
    await withApp(async ({ app, token }) => {
      const got = await app.request("/v1/projects/traceai/live-board-activity", {
        headers: personalHeaders(token, "alice"),
      });
      assert.equal(got.status, 200);
      assert.deepEqual(await got.json(), { enabled: false, project: "traceai" });

      const put = await app.request("/v1/projects/traceai/live-board-activity", {
        method: "PUT",
        headers: personalHeaders(token, "alice"),
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(put.status, 200);
      assert.deepEqual(await put.json(), { enabled: true, project: "traceai" });
    });

    await withApp(
      async ({ app, token }) => {
        const put = await app.request(
          "/v1/projects/traceai/live-board-activity",
          {
            method: "PUT",
            headers: personalHeaders(token, "alice"),
            body: JSON.stringify({ enabled: true }),
          },
        );
        assert.equal(put.status, 403);
      },
      { role: "viewer", enforceRoles: true },
    );
  });

  it("PUT rejects a non-boolean enabled", async () => {
    await withApp(async ({ app, token }) => {
      const put = await app.request("/v1/projects/traceai/live-board-activity", {
        method: "PUT",
        headers: personalHeaders(token, "alice"),
        body: JSON.stringify({ enabled: "true" }),
      });
      assert.equal(put.status, 400);
      const body = (await put.json()) as { code?: string };
      assert.equal(body.code, "VALIDATION");
    });
  });

  it("vlag uit: get_project / get_workflow summaries stay identical", async () => {
    await withApp(async ({ app, token }) => {
      const headers = personalHeaders(token, "alice");
      const project = await app.request("/v1/projects/traceai", { headers });
      assert.equal(project.status, 200);
      const projectBody = (await project.json()) as {
        agent_playbook: { summary: string; agent_policy: { summary: string } };
        default_workflow: { agent_policy: { summary: string } };
      };
      assert.equal(projectBody.agent_playbook.summary, SUMMARY);
      assert.equal(projectBody.agent_playbook.agent_policy.summary, SUMMARY);
      assert.equal(projectBody.default_workflow.agent_policy.summary, SUMMARY);
      assert.ok(
        !JSON.stringify(projectBody).includes("LIVE BOARD ACTIVITY"),
        "off must not inject the instruction",
      );

      const workflow = await app.request(
        "/v1/workflows/traceai-traceai-story",
        { headers },
      );
      assert.equal(workflow.status, 200);
      const workflowBody = (await workflow.json()) as {
        agent_policy: { summary: string };
        workflow_document: { agent_policy: { summary: string } };
      };
      assert.equal(workflowBody.agent_policy.summary, SUMMARY);
      assert.equal(workflowBody.workflow_document.agent_policy.summary, SUMMARY);
    });
  });

  it("vlag aan: injects into summaries, not into workflow_document", async () => {
    await withApp(
      async ({ app, token }) => {
        const headers = personalHeaders(token, "alice");
        const expected = `${SUMMARY}${LIVE_BOARD_ACTIVITY_INSTRUCTION}`;
        const project = await app.request("/v1/projects/traceai", { headers });
        const projectBody = (await project.json()) as {
          agent_playbook: { summary: string; agent_policy: { summary: string } };
          default_workflow: { agent_policy: { summary: string } };
        };
        assert.equal(projectBody.agent_playbook.summary, expected);
        assert.equal(projectBody.agent_playbook.agent_policy.summary, expected);
        assert.equal(projectBody.default_workflow.agent_policy.summary, expected);

        const workflow = await app.request(
          "/v1/workflows/traceai-traceai-story",
          { headers },
        );
        const workflowBody = (await workflow.json()) as {
          agent_policy: { summary: string };
          workflow_document: { agent_policy: { summary: string } };
        };
        assert.equal(workflowBody.agent_policy.summary, expected);
        assert.equal(
          workflowBody.workflow_document.agent_policy.summary,
          SUMMARY,
        );
      },
      { enabled: true },
    );
  });
});
