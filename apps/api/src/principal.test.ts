import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allowedProjects,
  mayAccessProject,
  resolvePrincipal,
  userSlugFromBridgeEmail,
} from "./principal.js";
import type { AuthActor } from "@traceai/auth";
import type { HumanIdentity } from "./human-identity.js";

function user(
  slug: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    slug,
    fields: {
      username: slug,
      display_name: slug,
      email: `${slug}@example.com`,
      status: "active",
      is_platform_admin: false,
      ...overrides,
    },
  };
}

function membership(project: string, userSlug: string) {
  return { slug: `${project}-member-${userSlug}`, fields: { project, user: userSlug } };
}

function service(input: {
  users?: Array<Record<string, unknown>>;
  memberships?: Array<{ fields: { project: string; user: string } }>;
  projects?: string[];
}) {
  const users = input.users ?? [];
  return {
    listTraceaiUsers: async () => users,
    getTraceaiUser: async (slug: string) =>
      users.find((u) => u.slug === slug) ?? null,
    listProjectMemberships: async () => input.memberships ?? [],
    listProjects: async () =>
      (input.projects ?? []).map((slug) => ({ slug, fields: { name: slug } })),
  } as never;
}

function human(overrides: Partial<HumanIdentity> = {}): HumanIdentity {
  return {
    user: "joostvl",
    slug: "joostvl",
    display_name: "Joost",
    is_platform_admin: false,
    mode: "personal",
    ...overrides,
  };
}

const agentScopes: AuthActor["scopes"] = ["projects:read", "tickets:read"];

describe("userSlugFromBridgeEmail", () => {
  it("parses the self-service bridge email", () => {
    assert.equal(
      userSlugFromBridgeEmail("ui+joostvl@users.traceai.local"),
      "joostvl",
    );
    assert.equal(
      userSlugFromBridgeEmail("UI+JoostVL@Users.TraceAI.local"),
      "joostvl",
    );
  });

  it("returns null for anything else", () => {
    assert.equal(userSlugFromBridgeEmail("joost@example.com"), null);
    assert.equal(userSlugFromBridgeEmail("ui+@users.traceai.local"), null);
    assert.equal(userSlugFromBridgeEmail(undefined), null);
  });
});

describe("resolvePrincipal + allowedProjects (TRA-81)", () => {
  it("U1: human with a membership sees only that project", async () => {
    const svc = service({
      users: [user("joostvl")],
      memberships: [membership("traceai", "joostvl"), membership("other", "someone")],
    });
    const principal = await resolvePrincipal({
      service: svc,
      human: human(),
      actor: { userId: "1", email: "x@y.z", name: "x", tokenId: "t", scopes: agentScopes },
    });
    assert.equal(principal.userSlug, "joostvl");
    const access = await allowedProjects(svc, principal);
    assert.notEqual(access, "all");
    assert.deepEqual([...(access as Set<string>)], ["traceai"]);
  });

  it("U2: platform admin human gets all", async () => {
    const svc = service({ users: [user("boss", { is_platform_admin: true })] });
    const principal = await resolvePrincipal({
      service: svc,
      human: human({ slug: "boss", is_platform_admin: true }),
      actor: undefined,
    });
    assert.equal(await allowedProjects(svc, principal), "all");
  });

  it("U3: token with a bridge email resolves to its user", async () => {
    const svc = service({
      users: [user("joostvl")],
      memberships: [membership("traceai", "joostvl")],
    });
    const principal = await resolvePrincipal({
      service: svc,
      human: null,
      actor: {
        userId: "1",
        email: "ui+joostvl@users.traceai.local",
        name: "agent",
        tokenId: "t",
        scopes: agentScopes,
      },
    });
    assert.equal(principal.userSlug, "joostvl");
    assert.equal(principal.source, "token");
    assert.deepEqual(
      [...((await allowedProjects(svc, principal)) as Set<string>)],
      ["traceai"],
    );
  });

  it("U4: token falls back to matching the TraceAI user email", async () => {
    const svc = service({ users: [user("joostvl")] });
    const principal = await resolvePrincipal({
      service: svc,
      human: null,
      actor: {
        userId: "1",
        email: "JoostVL@example.com",
        name: "agent",
        tokenId: "t",
        scopes: agentScopes,
      },
    });
    assert.equal(principal.userSlug, "joostvl");
  });

  it("U5: token without a resolvable user gets nothing", async () => {
    const svc = service({
      users: [user("joostvl")],
      memberships: [membership("traceai", "joostvl")],
    });
    const principal = await resolvePrincipal({
      service: svc,
      human: null,
      actor: {
        userId: "1",
        email: "stranger@example.com",
        name: "agent",
        tokenId: "t",
        scopes: agentScopes,
      },
    });
    assert.equal(principal.userSlug, null);
    const access = await allowedProjects(svc, principal);
    assert.equal((access as Set<string>).size, 0);
  });

  it("U5b: an agent of a platform admin is not itself a platform admin", async () => {
    // Every token in production belongs to a platform admin, so inheriting the
    // flag would leave membership enforcement without any effect on tokens.
    const svc = service({
      users: [user("boss", { is_platform_admin: true })],
      memberships: [membership("traceai", "boss")],
      projects: ["traceai", "secret"],
    });
    const principal = await resolvePrincipal({
      service: svc,
      human: null,
      actor: {
        userId: "1",
        email: "ui+boss@users.traceai.local",
        name: "agent",
        tokenId: "t",
        scopes: agentScopes,
      },
    });
    assert.equal(principal.isPlatformAdmin, false);
    const access = await allowedProjects(svc, principal);
    assert.notEqual(access, "all");
    assert.deepEqual([...(access as Set<string>)], ["traceai"]);
    assert.equal(mayAccessProject(access as Set<string>, "secret"), false);
  });

  it("U2b: a human does not inherit the carrying token's admin scope", async () => {
    // The web server proxies human requests with its OWN token, which holds
    // `admin` scope in every deployment. Inheriting it would give every signed-in
    // user access to every project - which is exactly what happened locally.
    const svc = service({
      users: [user("carstendlf")],
      memberships: [membership("traceai", "joostvl")],
      projects: ["traceai", "secret"],
    });
    const principal = await resolvePrincipal({
      service: svc,
      human: human({ slug: "carstendlf", is_platform_admin: false }),
      actor: {
        userId: "web",
        email: "joost@traceai.local",
        name: "web server",
        tokenId: "t",
        scopes: ["admin"],
      },
    });
    assert.equal(principal.hasAdminScope, false, "the token's scope is not the human's");
    const access = await allowedProjects(svc, principal);
    assert.notEqual(access, "all");
    assert.equal((access as Set<string>).size, 0, "no memberships means no projects");
  });

  it("U6: admin scope is the documented escape", async () => {
    const svc = service({ users: [] });
    const principal = await resolvePrincipal({
      service: svc,
      human: null,
      actor: {
        userId: "1",
        email: "infra@example.com",
        name: "infra",
        tokenId: "t",
        scopes: ["admin"],
      },
    });
    assert.equal(principal.hasAdminScope, true);
    assert.equal(await allowedProjects(svc, principal), "all");
  });

  it("U7: legacy login is no longer an implicit platform admin", async () => {
    const svc = service({
      users: [],
      memberships: [membership("traceai", "joostvl")],
      projects: ["traceai", "other"],
    });
    // is_platform_admin is deliberately true: that is what a real legacy
    // session sends (apps/web session.ts derives it from the mode). A test with
    // the flag on false would pass while production still granted everything.
    const principal = await resolvePrincipal({
      service: svc,
      human: human({ slug: null, mode: "legacy", is_platform_admin: true }),
      actor: undefined,
    });
    assert.equal(principal.isPlatformAdmin, false);
    const access = await allowedProjects(svc, principal);
    assert.notEqual(access, "all", "legacy must not bypass membership (F7)");
    assert.equal((access as Set<string>).size, 0);
  });

  it("U7b: a genuine platform admin flag still counts in personal mode", async () => {
    const svc = service({ users: [user("boss", { is_platform_admin: true })] });
    const principal = await resolvePrincipal({
      service: svc,
      human: human({ slug: "boss", is_platform_admin: true, mode: "personal" }),
      actor: undefined,
    });
    assert.equal(await allowedProjects(svc, principal), "all");
  });

  it("U8: two memberships, and no third project leaks in", async () => {
    const svc = service({
      users: [user("joostvl")],
      memberships: [
        membership("traceai", "joostvl"),
        membership("demo", "joostvl"),
        membership("secret", "someone-else"),
      ],
    });
    const principal = await resolvePrincipal({
      service: svc,
      human: human(),
      actor: undefined,
    });
    const access = (await allowedProjects(svc, principal)) as Set<string>;
    assert.deepEqual([...access].sort(), ["demo", "traceai"]);
    assert.equal(mayAccessProject(access, "secret"), false);
  });

  it("a disabled user keeps no project access", async () => {
    const svc = service({
      users: [user("gone", { status: "disabled" })],
      memberships: [membership("traceai", "gone")],
    });
    const principal = await resolvePrincipal({
      service: svc,
      human: null,
      actor: {
        userId: "1",
        email: "ui+gone@users.traceai.local",
        name: "agent",
        tokenId: "t",
        scopes: agentScopes,
      },
    });
    assert.equal(principal.userSlug, null);
    assert.equal(((await allowedProjects(svc, principal)) as Set<string>).size, 0);
  });
});
