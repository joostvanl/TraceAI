import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, DEFAULT_AGENT_SCOPES } from "@traceai/auth";
import { createApp } from "./app.js";

/**
 * TRA-81: the point of these tests is not that the member gets in, but that the
 * non-member does not — and cannot tell the project exists.
 */

const OWN = "traceai";
const FOREIGN = "secret-project";

function project(slug: string) {
  return {
    id: `id-${slug}`,
    slug,
    fields: {
      name: `Name of ${slug}`,
      description: `Description of ${slug}`,
      default_workflow: null,
      project_key: slug.slice(0, 3).toUpperCase(),
    },
  };
}

function stubService(options: { memberships?: Array<[string, string]> } = {}) {
  const memberships = (options.memberships ?? [[OWN, "joostvl"]]).map(
    ([p, u]) => ({ slug: `${p}-member-${u}`, fields: { project: p, user: u } }),
  );
  return {
    listProjects: async () => [project(OWN), project(FOREIGN)],
    listProjectMemberships: async () => memberships,
    listTraceaiUsers: async () => [
      {
        slug: "joostvl",
        fields: { username: "joostvl", status: "active", is_platform_admin: false },
      },
    ],
    getTraceaiUser: async (slug: string) =>
      slug === "joostvl"
        ? {
            slug: "joostvl",
            fields: {
              username: "joostvl",
              status: "active",
              is_platform_admin: false,
            },
          }
        : null,
    getProject: async (slug: string) => ({
      project: project(slug),
      workflow: null,
      stages: [],
      workflow_document: null,
    }),
    assertProjectRole: async () => {
      throw new Error("Role admin is required for this action");
    },
    listProjectMembershipsForProject: async () => [],
  } as never;
}

/** Runs `fn` with a token whose AuthStore email is `email`. */
async function withToken(
  email: string,
  scopes: string[],
  service: unknown,
  fn: (app: ReturnType<typeof createApp>, token: string) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "traceai-project-access-"));
  const store = new AuthStore(join(dir, "auth.sqlite"));
  try {
    const user = store.createUser({ email, name: "Tester" });
    const token = store.createToken({
      userId: user.id,
      name: "agent",
      scopes: scopes as never,
    });
    const app = createApp({ authStore: store, service: service as never });
    await fn(app, token.token);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const MEMBER_EMAIL = "ui+joostvl@users.traceai.local";
const STRANGER_EMAIL = "stranger@example.com";
const AGENT = [...DEFAULT_AGENT_SCOPES];

function get(
  app: ReturnType<typeof createApp>,
  token: string,
  path: string,
) {
  return app.request(path, { headers: { Authorization: `Bearer ${token}` } });
}

describe("project access (TRA-81)", () => {
  it("P1: the project list contains only projects the user is a member of", async () => {
    await withToken(MEMBER_EMAIL, AGENT, stubService(), async (app, token) => {
      const res = await get(app, token, "/v1/projects");
      assert.equal(res.status, 200);
      const body = (await res.json()) as Array<{ slug: string }>;
      assert.deepEqual(
        body.map((p) => p.slug),
        [OWN],
      );
    });
  });

  it("P2: a user without any membership gets an empty list, not an error", async () => {
    await withToken(
      MEMBER_EMAIL,
      AGENT,
      stubService({ memberships: [] }),
      async (app, token) => {
        const res = await get(app, token, "/v1/projects");
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), []);
      },
    );
  });

  it("P3: a foreign project is 404 and the body leaks nothing", async () => {
    await withToken(MEMBER_EMAIL, AGENT, stubService(), async (app, token) => {
      const res = await get(app, token, `/v1/projects/${FOREIGN}`);
      assert.equal(res.status, 404, "404 hides existence; 403 would confirm it");
      const raw = await res.text();
      assert.ok(!raw.includes("Name of"), "must not leak the project name");
      assert.ok(!raw.includes("Description of"), "must not leak the description");
      assert.ok(!raw.includes("agent_playbook"), "must not leak the playbook");
    });
  });

  it("P4: every project sub-route is covered by the middleware", async () => {
    const paths = ["search", "history", "insights", "members"];
    await withToken(MEMBER_EMAIL, AGENT, stubService(), async (app, token) => {
      for (const path of paths) {
        const res = await get(app, token, `/v1/projects/${FOREIGN}/${path}`);
        assert.equal(res.status, 404, `${path} must be 404 for a non-member`);
      }
    });
  });

  it("P5: role enforcement for agent tokens is a known gap, not a 404", async () => {
    // `enforceProjectRole` returns early when there is no human identity, so an
    // agent token skips the role check entirely — even though this stub's
    // assertProjectRole would refuse. TRA-81 scopes membership, not roles
    // ("geen rollen of rechten wijzigen"), so this documents the gap instead of
    // hiding it: the request must get *past* the membership guard (not 404),
    // and the missing role check is tracked separately.
    const service = {
      ...(stubService() as unknown as Record<string, unknown>),
      setProjectMembership: async () => ({
        slug: `${OWN}-member-someone`,
        fields: { project: OWN, user: "someone", role: "viewer" },
      }),
    };
    await withToken(
      MEMBER_EMAIL,
      [...AGENT, "projects:write"],
      service,
      async (app, token) => {
        const res = await app.request(`/v1/projects/${OWN}/members`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ user: "someone", role: "viewer" }),
        });
        assert.notEqual(res.status, 404, "membership guard must let a member through");
        assert.notEqual(res.status, 403, "documents that tokens skip the role check");
      },
    );
  });

  it("P7: a token with admin scope reaches every project", async () => {
    await withToken(STRANGER_EMAIL, ["admin"], stubService(), async (app, token) => {
      const res = await get(app, token, `/v1/projects/${FOREIGN}`);
      assert.equal(res.status, 200);
      const list = await get(app, token, "/v1/projects");
      const body = (await list.json()) as Array<{ slug: string }>;
      assert.deepEqual(body.map((p) => p.slug).sort(), [OWN, FOREIGN].sort());
    });
  });

  it("P8: a token without a resolvable TraceAI user sees nothing", async () => {
    await withToken(STRANGER_EMAIL, AGENT, stubService(), async (app, token) => {
      const list = await get(app, token, "/v1/projects");
      assert.deepEqual(await list.json(), []);
      const own = await get(app, token, `/v1/projects/${OWN}`);
      assert.equal(own.status, 404);
    });
  });

  it("P9/P10: creating a project grants access to it right away", async () => {
    // F2: without a membership nobody sees anything, so creating a project must
    // be the way in — including for an agent token, whose TraceAI user is derived
    // from the token instead of from a session.
    const memberships: Array<{
      slug: string;
      fields: { project: string; user: string };
    }> = [];
    let ownerPassed: string | undefined = "not-called";
    const service = {
      ...(stubService({ memberships: [] }) as unknown as Record<string, unknown>),
      listProjectMemberships: async () => memberships,
      listProjects: async () => [project(FOREIGN), project("fresh")],
      createProject: async (input: { ownerUser?: string }) => {
        ownerPassed = input.ownerUser;
        if (input.ownerUser) {
          memberships.push({
            slug: `fresh-member-${input.ownerUser}`,
            fields: { project: "fresh", user: input.ownerUser },
          });
        }
        return { project: project("fresh"), workflow: null, wiki_pages: [] };
      },
    };

    await withToken(
      MEMBER_EMAIL,
      [...AGENT, "projects:write"],
      service,
      async (app, token) => {
        const before = await get(app, token, "/v1/projects");
        assert.deepEqual(await before.json(), [], "starts with nothing (P2)");

        const created = await app.request("/v1/projects", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "Fresh" }),
        });
        assert.equal(created.status, 201, await created.clone().text());
        assert.equal(
          ownerPassed,
          "joostvl",
          "the token's TraceAI user must become the owner, or it loses its own project",
        );

        const after = await get(app, token, "/v1/projects");
        const slugs = ((await after.json()) as Array<{ slug: string }>).map(
          (p) => p.slug,
        );
        assert.deepEqual(slugs, ["fresh"], "P10: visible immediately, and only that one");

        const detail = await get(app, token, "/v1/projects/fresh");
        assert.equal(detail.status, 200, "and reachable in detail");
      },
    );
  });

  it("P3b: a member still reaches their own project", async () => {
    await withToken(MEMBER_EMAIL, AGENT, stubService(), async (app, token) => {
      const res = await get(app, token, `/v1/projects/${OWN}`);
      assert.equal(res.status, 200, "membership must not be blocked by the guard");
    });
  });
});
