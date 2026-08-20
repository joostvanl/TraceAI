import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "@traceai/auth";
import { NotFoundError, ValidationError } from "@traceai/core";
import { createApp } from "./app.js";
import { signHumanIdentity } from "./human-identity.js";
import { projectMemberStubs } from "./test-support.js";

const ALPHA = "alpha";
const SESSION_SECRET = "tra-88-session-secret";
const PROXY_SECRET = "tra-88-proxy-secret";

function workflow(slug: string, project: string, name = slug) {
  return { slug, fields: { name, project } };
}

function projectEntry(slug: string, defaultWorkflow: string) {
  return {
    id: `id-${slug}`,
    slug,
    fields: {
      name: slug,
      description: "",
      default_workflow: defaultWorkflow,
      project_key: slug.slice(0, 3).toUpperCase(),
    },
  };
}

function withEnv(fn: () => Promise<void>) {
  const prevSession = process.env.TRACEAI_SESSION_SECRET;
  const prevProxy = process.env.TRACEAI_HUMAN_PROXY_SECRET;
  process.env.TRACEAI_SESSION_SECRET = SESSION_SECRET;
  process.env.TRACEAI_HUMAN_PROXY_SECRET = PROXY_SECRET;
  return fn().finally(() => {
    if (prevSession === undefined) delete process.env.TRACEAI_SESSION_SECRET;
    else process.env.TRACEAI_SESSION_SECRET = prevSession;
    if (prevProxy === undefined) delete process.env.TRACEAI_HUMAN_PROXY_SECRET;
    else process.env.TRACEAI_HUMAN_PROXY_SECRET = prevProxy;
  });
}

async function withUser(
  input: {
    email: string;
    userSlug: string;
    role: "admin" | "editor" | "viewer";
    projects: string[];
    scopes: string[];
    platformAdmin?: boolean;
  },
  serviceExtra: Record<string, unknown>,
  fn: (
    app: ReturnType<typeof createApp>,
    headers: Record<string, string>,
  ) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "traceai-tra88-"));
  const store = new AuthStore(join(dir, "auth.sqlite"));
  try {
    const user = store.createUser({ email: input.email, name: input.userSlug });
    const token = store.createToken({
      userId: user.id,
      name: "t",
      scopes: input.scopes as never,
    });
    const service = {
      ...projectMemberStubs({
        email: input.email,
        userSlug: input.userSlug,
        projects: input.projects,
        role: input.role,
      }),
      getTraceaiUser: async (slug: string) =>
        slug === input.userSlug
          ? {
              id: `id-${input.userSlug}`,
              slug: input.userSlug,
              fields: {
                username: input.userSlug,
                email: input.email,
                status: "active",
                is_platform_admin: input.platformAdmin === true,
              },
            }
          : null,
      assertProjectRole: async ({
        required,
      }: {
        required: string;
      }) => {
        if (required === "admin" && input.role !== "admin") {
          throw new Error("Role admin is required for this action");
        }
        return input.role;
      },
      ...serviceExtra,
    };
    const app = createApp({ authStore: store, service: service as never });
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token.token}`,
      "Content-Type": "application/json",
    };
    if (input.platformAdmin) {
      headers["x-traceai-human-proxy"] = PROXY_SECRET;
      headers["x-traceai-human-identity"] = signHumanIdentity(
        {
          user: input.userSlug,
          slug: input.userSlug,
          display_name: input.userSlug,
          is_platform_admin: true,
          mode: "personal",
        },
        SESSION_SECRET,
      );
    }
    await fn(app, headers);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("PATCH /v1/projects/:slug default_workflow (TRA-88)", () => {
  it("D1: alice sets an own-project workflow as default", async () => {
    let called: { project?: string; workflow?: string } = {};
    await withUser(
      {
        email: "ui+alice@users.traceai.local",
        userSlug: "alice",
        role: "admin",
        projects: [ALPHA],
        scopes: ["projects:write"],
      },
      {
        setProjectDefaultWorkflow: async (project: string, workflow: string) => {
          called = { project, workflow };
          return projectEntry(project, workflow);
        },
      },
      async (app, headers) => {
        const res = await app.request(`/v1/projects/${ALPHA}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ default_workflow: "alpha-extra" }),
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { default_workflow?: string };
        assert.equal(body.default_workflow, "alpha-extra");
        assert.equal(called.project, ALPHA);
        assert.equal(called.workflow, "alpha-extra");
      },
    );
  });

  it("D3/D4: foreign or unknown workflow is 400", async () => {
    await withUser(
      {
        email: "ui+alice@users.traceai.local",
        userSlug: "alice",
        role: "admin",
        projects: [ALPHA],
        scopes: ["projects:write"],
      },
      {
        setProjectDefaultWorkflow: async (_project: string, workflow: string) => {
          throw new ValidationError(
            `Workflow "${workflow}" is not a workflow of project ${ALPHA}`,
          );
        },
      },
      async (app, headers) => {
        for (const slug of ["beta-standard-worker", "nope"]) {
          const res = await app.request(`/v1/projects/${ALPHA}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({ default_workflow: slug }),
          });
          assert.equal(res.status, 400);
          assert.equal(
            ((await res.json()) as { code?: string }).code,
            "VALIDATION",
          );
        }
      },
    );
  });

  it("D5: unknown keys are 400", async () => {
    await withUser(
      {
        email: "ui+alice@users.traceai.local",
        userSlug: "alice",
        role: "admin",
        projects: [ALPHA],
        scopes: ["projects:write"],
      },
      {
        setProjectDefaultWorkflow: async () => {
          throw new Error("should not be called");
        },
      },
      async (app, headers) => {
        const res = await app.request(`/v1/projects/${ALPHA}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ name: "x" }),
        });
        assert.equal(res.status, 400);
      },
    );
  });

  it("D6: bob (editor) cannot set default", async () => {
    await withUser(
      {
        email: "ui+bob@users.traceai.local",
        userSlug: "bob",
        role: "editor",
        projects: [ALPHA],
        scopes: ["projects:write"],
      },
      {
        setProjectDefaultWorkflow: async () => {
          throw new Error("should not be called");
        },
      },
      async (app, headers) => {
        const res = await app.request(`/v1/projects/${ALPHA}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ default_workflow: "alpha-extra" }),
        });
        assert.equal(res.status, 403);
      },
    );
  });

  it("D7: carol (non-member) gets 404", async () => {
    await withUser(
      {
        email: "ui+carol@users.traceai.local",
        userSlug: "carol",
        role: "admin",
        projects: ["beta"],
        scopes: ["projects:write"],
      },
      {
        listProjectMemberships: async () => [
          {
            slug: "beta-member-carol",
            fields: { project: "beta", user: "carol", role: "admin" },
          },
        ],
        setProjectDefaultWorkflow: async () => {
          throw new Error("should not be called");
        },
      },
      async (app, headers) => {
        const res = await app.request(`/v1/projects/${ALPHA}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ default_workflow: "alpha-extra" }),
        });
        assert.equal(res.status, 404);
      },
    );
  });
});

describe("POST /v1/projects/:slug/workflows/clone (TRA-88)", () => {
  it("K1: platform-admin clones a foreign workflow", async () => {
    await withEnv(async () => {
      let called: { source?: string; project?: string } = {};
      await withUser(
        {
          email: "ui+root@users.traceai.local",
          userSlug: "root",
          role: "admin",
          projects: [ALPHA],
          scopes: ["workflows:write"],
          platformAdmin: true,
        },
        {
          cloneWorkflow: async (input: { source: string; project: string }) => {
            called = input;
            return workflow("alpha-beta-standard-worker", ALPHA, "Standard Worker");
          },
        },
        async (app, headers) => {
          const res = await app.request(
            `/v1/projects/${ALPHA}/workflows/clone`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({ source: "beta-standard-worker" }),
            },
          );
          assert.equal(res.status, 201);
          const body = (await res.json()) as {
            slug?: string;
            project?: string;
          };
          assert.equal(body.slug, "alpha-beta-standard-worker");
          assert.notEqual(body.slug, "beta-standard-worker");
          assert.equal(body.project, ALPHA);
          assert.equal(called.source, "beta-standard-worker");
          assert.equal(called.project, ALPHA);
        },
      );
    });
  });

  it("K2: alice (admin, no platform) gets 403", async () => {
    await withUser(
      {
        email: "ui+alice@users.traceai.local",
        userSlug: "alice",
        role: "admin",
        projects: [ALPHA],
        scopes: ["workflows:write"],
      },
      {
        cloneWorkflow: async () => {
          throw new Error("should not be called");
        },
      },
      async (app, headers) => {
        const res = await app.request(`/v1/projects/${ALPHA}/workflows/clone`, {
          method: "POST",
          headers,
          body: JSON.stringify({ source: "beta-standard-worker" }),
        });
        assert.equal(res.status, 403);
      },
    );
  });

  it("K3: bob (editor) gets 403", async () => {
    await withUser(
      {
        email: "ui+bob@users.traceai.local",
        userSlug: "bob",
        role: "editor",
        projects: [ALPHA],
        scopes: ["workflows:write"],
      },
      {
        cloneWorkflow: async () => {
          throw new Error("should not be called");
        },
      },
      async (app, headers) => {
        const res = await app.request(`/v1/projects/${ALPHA}/workflows/clone`, {
          method: "POST",
          headers,
          body: JSON.stringify({ source: "beta-standard-worker" }),
        });
        assert.equal(res.status, 403);
      },
    );
  });

  it("K4: carol (non-member) gets 404, not 403", async () => {
    await withUser(
      {
        email: "ui+carol@users.traceai.local",
        userSlug: "carol",
        role: "admin",
        projects: ["beta"],
        scopes: ["workflows:write"],
      },
      {
        listProjectMemberships: async () => [
          {
            slug: "beta-member-carol",
            fields: { project: "beta", user: "carol", role: "admin" },
          },
        ],
        cloneWorkflow: async () => {
          throw new Error("should not be called");
        },
      },
      async (app, headers) => {
        const res = await app.request(`/v1/projects/${ALPHA}/workflows/clone`, {
          method: "POST",
          headers,
          body: JSON.stringify({ source: "beta-standard-worker" }),
        });
        assert.equal(res.status, 404);
      },
    );
  });

  it("K5: missing source after platform-check is 404", async () => {
    await withEnv(async () => {
      await withUser(
        {
          email: "ui+root@users.traceai.local",
          userSlug: "root",
          role: "admin",
          projects: [ALPHA],
          scopes: ["workflows:write"],
          platformAdmin: true,
        },
        {
          cloneWorkflow: async () => {
            throw new NotFoundError("Workflow not found: missing");
          },
        },
        async (app, headers) => {
          const res = await app.request(
            `/v1/projects/${ALPHA}/workflows/clone`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({ source: "missing" }),
            },
          );
          assert.equal(res.status, 404);
        },
      );
    });
  });
});

describe("POST /v1/workflows create (TRA-88)", () => {
  it("C2: bob cannot create a workflow", async () => {
    await withUser(
      {
        email: "ui+bob@users.traceai.local",
        userSlug: "bob",
        role: "editor",
        projects: [ALPHA],
        scopes: ["workflows:write"],
      },
      {
        createWorkflow: async () => {
          throw new Error("should not be called");
        },
      },
      async (app, headers) => {
        const res = await app.request("/v1/workflows", {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "Intake licht", project: ALPHA }),
        });
        assert.equal(res.status, 403);
      },
    );
  });
});
