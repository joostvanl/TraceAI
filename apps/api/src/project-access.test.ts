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

  it("R1: an agent token with too low a role gets 403, not a pass (TRA-82)", async () => {
    // This was P5 under TRA-81, where it asserted the *absence* of a 403:
    // `enforceProjectRole` began with `if (!identity) return null`, so an agent
    // token skipped the role check even though this stub's assertProjectRole
    // refuses. TRA-82 closed that, so the assertion flips.
    //
    // Both halves still matter. 404 would mean the membership guard wrongly
    // rejected a member; 403 means the member got past it and was stopped by the
    // role check, which is the point.
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
        assert.equal(
          res.status,
          403,
          "an agent token must be held to its user's project role",
        );
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

/* ------------------------------------------------------------------ TRA-82 */

const SECRET_TITLE = "Secret foreign title";
const SECRET_DESCRIPTION = "Secret foreign description";
const SECRET_COMMENT = "Secret foreign comment";
const SECRET_BODY = "Secret foreign wiki body";
/** Belongs to no project, so it is nobody's to hide (`traceai-default`). */
const SHARED_WORKFLOW = "shared-default";

function ticket(slug: string, projectSlug: string, secret = false) {
  return {
    id: `id-${slug}`,
    slug,
    fields: {
      title: secret ? SECRET_TITLE : "Own ticket",
      description: secret ? SECRET_DESCRIPTION : "Own description",
      project: projectSlug,
      workflow: `${projectSlug}-wf`,
      stage: "backlog",
      priority: "medium",
      ticket_key: "X-1",
      ticket_number: 1,
      tokens_estimate: null,
      tokens_actual: null,
      resolution: null,
      review_state: null,
      parent: null,
      sort_order: 0,
    },
  };
}

function wikiPage(slug: string, projectSlug: string, secret = false) {
  return {
    id: `id-${slug}`,
    slug,
    updatedAt: "2026-08-19T00:00:00.000Z",
    fields: {
      title: secret ? SECRET_TITLE : "Own page",
      body: secret ? SECRET_BODY : "Own body",
      project: projectSlug,
      parent: null,
      sort_order: 0,
      updated_by: "agent",
    },
  };
}

function workflow(slug: string, projectSlug: string | null) {
  return {
    id: `id-${slug}`,
    slug,
    fields: { name: `Workflow ${slug}`, project: projectSlug, stages_json: null },
  };
}

/** stubService plus the ticket/wiki/workflow reads the TRA-82 routes need. */
function contentService(options: { memberships?: Array<[string, string]> } = {}) {
  const tickets = [ticket("own-ticket", OWN), ticket("foreign-ticket", FOREIGN, true)];
  const pages = [wikiPage("own-page", OWN), wikiPage("foreign-page", FOREIGN, true)];
  const workflows = [
    workflow(`${OWN}-wf`, OWN),
    workflow(`${FOREIGN}-wf`, FOREIGN),
    workflow(SHARED_WORKFLOW, null),
  ];
  return {
    ...(stubService(options) as unknown as Record<string, unknown>),
    listTickets: async (input: { project: string }) =>
      tickets.filter((t) => t.fields.project === input.project),
    getTicket: async (slug: string) => {
      const found = tickets.find((t) => t.slug === slug);
      if (!found) return null;
      return {
        ticket: found,
        comments: [
          {
            slug: `${slug}-c`,
            fields: {
              author: "agent",
              body: found.fields.project === FOREIGN ? SECRET_COMMENT : "Own comment",
            },
            createdAt: "2026-08-19T00:00:00.000Z",
          },
        ],
        children: [],
        parent_ticket: null,
        tokens_estimate_rollup: 0,
        tokens_actual_rollup: 0,
      };
    },
    addComment: async () => ({
      slug: "new-comment",
      fields: { ticket: "foreign-ticket", author: "agent", body: "x" },
    }),
    listWikiPages: async (input: { project: string }) => {
      const items = pages.filter((p) => p.fields.project === input.project);
      return { items, total: items.length, limit: 500, offset: 0 };
    },
    getWikiPage: async (slug: string) => pages.find((p) => p.slug === slug) ?? null,
    listWorkflows: async (projectSlug?: string) =>
      projectSlug
        ? workflows.filter((w) => w.fields.project === projectSlug)
        : workflows,
    getWorkflow: async (slug: string) => {
      const found = workflows.find((w) => w.slug === slug);
      if (!found) return null;
      return {
        workflow: found,
        stages: [],
        workflow_document: { version: 1, agent_policy: {}, stages: [] },
      };
    },
  } as never;
}

describe("project-scoped routes outside /v1/projects (TRA-82)", () => {
  it("M1: a ticket list for a foreign project is 404, not a list", async () => {
    await withToken(MEMBER_EMAIL, AGENT, contentService(), async (app, token) => {
      const res = await get(app, token, `/v1/tickets?project=${FOREIGN}`);
      assert.equal(res.status, 404);
      const raw = await res.text();
      assert.ok(!raw.includes(SECRET_TITLE), "must not leak ticket titles");
    });
  });

  it("M2: a foreign ticket by slug is 404 and leaks no content", async () => {
    await withToken(MEMBER_EMAIL, AGENT, contentService(), async (app, token) => {
      const res = await get(app, token, "/v1/tickets/foreign-ticket");
      assert.equal(res.status, 404);
      const raw = await res.text();
      // The status alone is not enough: F3 is an information requirement.
      assert.ok(!raw.includes(SECRET_TITLE), "must not leak the title");
      assert.ok(!raw.includes(SECRET_DESCRIPTION), "must not leak the description");
      assert.ok(!raw.includes(SECRET_COMMENT), "must not leak comments");
      const body = (await JSON.parse(raw)) as { message: string };
      assert.equal(
        body.message,
        "Ticket not found",
        "the message must match a genuinely missing ticket, or the difference itself leaks",
      );
    });
  });

  it("M3: a wiki list for a foreign project is 404", async () => {
    await withToken(MEMBER_EMAIL, AGENT, contentService(), async (app, token) => {
      const res = await get(app, token, `/v1/wiki-pages?project=${FOREIGN}`);
      assert.equal(res.status, 404);
    });
  });

  it("M4: a foreign wiki page by slug is 404 and leaks no body", async () => {
    await withToken(MEMBER_EMAIL, AGENT, contentService(), async (app, token) => {
      const res = await get(app, token, "/v1/wiki-pages/foreign-page");
      assert.equal(res.status, 404);
      const raw = await res.text();
      assert.ok(!raw.includes(SECRET_BODY), "must not leak the page body");
      assert.equal(
        (JSON.parse(raw) as { message: string }).message,
        "Wiki page not found",
      );
    });
  });

  it("M5/M6: foreign workflows are 404 by filter and by slug", async () => {
    await withToken(MEMBER_EMAIL, AGENT, contentService(), async (app, token) => {
      const list = await get(app, token, `/v1/workflows?project=${FOREIGN}`);
      assert.equal(list.status, 404);
      const detail = await get(app, token, `/v1/workflows/${FOREIGN}-wf`);
      assert.equal(detail.status, 404);
    });
  });

  it("M7: commenting on a foreign ticket is refused", async () => {
    await withToken(
      MEMBER_EMAIL,
      [...AGENT, "comments:write"],
      contentService(),
      async (app, token) => {
        const res = await app.request("/v1/comments", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ticket: "foreign-ticket", body: "hello" }),
        });
        assert.equal(res.status, 404);
      },
    );
  });

  it("M8: creating a ticket in a foreign project is refused", async () => {
    await withToken(
      MEMBER_EMAIL,
      AGENT,
      contentService(),
      async (app, token) => {
        const res = await app.request("/v1/tickets", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ project: FOREIGN, title: "Sneak" }),
        });
        assert.equal(res.status, 404);
      },
    );
  });

  it("M11: a member keeps full access to their own project", async () => {
    await withToken(MEMBER_EMAIL, AGENT, contentService(), async (app, token) => {
      const list = await get(app, token, `/v1/tickets?project=${OWN}`);
      assert.equal(list.status, 200);
      assert.equal(((await list.json()) as unknown[]).length, 1);

      const detail = await get(app, token, "/v1/tickets/own-ticket");
      assert.equal(detail.status, 200);

      const wiki = await get(app, token, `/v1/wiki-pages?project=${OWN}`);
      assert.equal(wiki.status, 200);

      const page = await get(app, token, "/v1/wiki-pages/own-page");
      assert.equal(page.status, 200);

      const wf = await get(app, token, `/v1/workflows/${OWN}-wf`);
      assert.equal(wf.status, 200);
    });
  });

  it("M13: an admin-scope token reaches every project", async () => {
    await withToken(STRANGER_EMAIL, ["admin"], contentService(), async (app, token) => {
      const list = await get(app, token, `/v1/tickets?project=${FOREIGN}`);
      assert.equal(list.status, 200);
      const detail = await get(app, token, "/v1/tickets/foreign-ticket");
      assert.equal(detail.status, 200);
    });
  });

  it("W1/W2: the unfiltered workflow list hides other projects", async () => {
    await withToken(MEMBER_EMAIL, AGENT, contentService(), async (app, token) => {
      const res = await get(app, token, "/v1/workflows");
      assert.equal(res.status, 200);
      const slugs = ((await res.json()) as Array<{ slug: string }>).map(
        (w) => w.slug,
      );
      assert.ok(slugs.includes(`${OWN}-wf`), "own workflow stays visible");
      assert.ok(!slugs.includes(`${FOREIGN}-wf`), "a foreign workflow must drop out");
    });
  });

  it("W3/W4: a workflow without a project stays visible to everyone", async () => {
    // The trap this guards: filtering on `mayAccessProject(access, w.project)`
    // makes an empty project field fail the check, which would hide
    // `traceai-default` from every principal — an outage, not a fix.
    await withToken(MEMBER_EMAIL, AGENT, contentService(), async (app, token) => {
      const list = await get(app, token, "/v1/workflows");
      const slugs = ((await list.json()) as Array<{ slug: string }>).map(
        (w) => w.slug,
      );
      assert.ok(slugs.includes(SHARED_WORKFLOW), "project-less workflow must survive");

      const detail = await get(app, token, `/v1/workflows/${SHARED_WORKFLOW}`);
      assert.equal(detail.status, 200, "and stay readable by slug");
    });

    // Also for someone with no memberships at all.
    await withToken(
      MEMBER_EMAIL,
      AGENT,
      contentService({ memberships: [] }),
      async (app, token) => {
        const detail = await get(app, token, `/v1/workflows/${SHARED_WORKFLOW}`);
        assert.equal(detail.status, 200);
      },
    );
  });

  it("R5: a token with no resolvable user reads nothing, not even its own", async () => {
    await withToken(STRANGER_EMAIL, AGENT, contentService(), async (app, token) => {
      const list = await get(app, token, `/v1/tickets?project=${OWN}`);
      assert.equal(list.status, 404);
      const detail = await get(app, token, "/v1/tickets/own-ticket");
      assert.equal(detail.status, 404);
    });
  });
});
