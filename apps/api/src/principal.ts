import { hasScope, type AuthActor } from "@traceai/auth";
import type { TraceService } from "@traceai/core";
import type { HumanIdentity } from "./human-identity.js";

/**
 * Self-service tokens hang off AuthStore users with a bridge email, so the
 * TraceAI user slug is recoverable from the token's email.
 * See `authEmailForUiSlug` in self-service-tokens.ts.
 */
const BRIDGE_PREFIX = "ui+";
const BRIDGE_SUFFIX = "@users.traceai.local";

/** `ui+joostvl@users.traceai.local` → `joostvl`. Null when it is not a bridge email. */
export function userSlugFromBridgeEmail(
  email: string | null | undefined,
): string | null {
  const value = email?.trim().toLowerCase();
  if (!value?.startsWith(BRIDGE_PREFIX) || !value.endsWith(BRIDGE_SUFFIX)) {
    return null;
  }
  const slug = value.slice(BRIDGE_PREFIX.length, -BRIDGE_SUFFIX.length).trim();
  return slug || null;
}

/**
 * Who is acting on this request — a human via the web proxy, or an agent token.
 * `userSlug` is the TraceAI user whose project memberships apply; null means
 * "not resolvable", which grants nothing (deny by default).
 */
export type Principal = {
  userSlug: string | null;
  isPlatformAdmin: boolean;
  /** Token-level `admin` scope: the documented escape for infra/cross-project work. */
  hasAdminScope: boolean;
  source: "human-proxy" | "token";
};

/** Projects a principal may see. `"all"` bypasses membership entirely. */
export type ProjectAccess = Set<string> | "all";

export async function resolvePrincipal(input: {
  service: TraceService;
  human: HumanIdentity | null;
  actor: AuthActor | undefined;
}): Promise<Principal> {
  const { service, human, actor } = input;
  const hasAdminScope = actor ? hasScope(actor.scopes, ["admin"]) : false;

  if (human) {
    // A legacy login is no longer an implicit platform admin for project access
    // (TRA-81 F7). The flag cannot simply be trusted: the web session sets
    // `is_platform_admin: true` for every legacy login (apps/web session.ts),
    // so mode has to override it here or F7 stays open in production.
    // Role enforcement still honours legacy (app.ts enforceProjectRole) — that
    // is a permission question and outside this ticket.
    const legacy = human.mode === "legacy";
    return {
      userSlug: human.slug,
      isPlatformAdmin: !legacy && human.is_platform_admin === true,
      hasAdminScope,
      source: "human-proxy",
    };
  }

  const email = actor?.email;
  const user = email ? await findTraceaiUserByEmail(service, email) : null;
  return {
    // A disabled user keeps no project access, whatever its token says.
    userSlug: user && user.fields.status === "active" ? user.slug : null,
    // Deliberately not inherited from the user: an agent of a platform admin is
    // not itself a platform admin. The AC names the token escape as the `admin`
    // *scope*, and letting the flag through would make membership enforcement
    // meaningless for exactly the tokens that matter — every token in production
    // today belongs to a platform admin.
    isPlatformAdmin: false,
    hasAdminScope,
    source: "token",
  };
}

async function findTraceaiUserByEmail(service: TraceService, email: string) {
  const want = email.trim().toLowerCase();
  const bridgeSlug = userSlugFromBridgeEmail(want);
  if (bridgeSlug) {
    const user = await service.getTraceaiUser(bridgeSlug);
    if (user) return user;
  }
  // Operator-created tokens may use the TraceAI user's own email instead.
  const users = await service.listTraceaiUsers();
  return (
    users.find((u) => (u.fields.email ?? "").trim().toLowerCase() === want) ??
    null
  );
}

export async function allowedProjects(
  service: TraceService,
  principal: Principal,
): Promise<ProjectAccess> {
  if (principal.isPlatformAdmin || principal.hasAdminScope) return "all";
  if (!principal.userSlug) return new Set<string>();
  const memberships = await service.listProjectMemberships();
  return new Set(
    memberships
      .filter((m) => m.fields.user === principal.userSlug)
      .map((m) => m.fields.project)
      .filter((slug): slug is string => Boolean(slug)),
  );
}

export function mayAccessProject(
  access: ProjectAccess,
  projectSlug: string,
): boolean {
  return access === "all" || access.has(projectSlug);
}
