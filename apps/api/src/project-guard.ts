import type { Context, Next } from "hono";
import type { AuthActor } from "@traceai/auth";
import type { TraceService } from "@traceai/core";
import type { HumanIdentity } from "./human-identity.js";
import type { AppVariables } from "./middleware.js";
import {
  allowedProjects,
  mayAccessProject,
  resolvePrincipal,
  type Principal,
  type ProjectAccess,
} from "./principal.js";

/**
 * TRA-82. TRA-81 put the membership check in middleware on `/v1/projects/:slug`,
 * which only works while the project sits in the path. Routes that take their
 * project from a query parameter (`/v1/tickets?project=`) or from the resource
 * they just loaded (`/v1/tickets/:slug`) never ran a check at all.
 *
 * Mounting that middleware on more paths cannot fix it: it reads
 * `c.req.param("slug")`, which on `/v1/tickets/:slug` is a *ticket* slug. It
 * would look like a check and be none. So resolution moves here — once per
 * request, shared — and the decision moves into each route, which is the only
 * place that knows which project it is touching.
 */
export type ProjectGuard = {
  /** Who is acting on this request. Resolved at most once per request. */
  principal(): Promise<Principal>;
  /** Which projects that principal may see. Resolved at most once per request. */
  access(): Promise<ProjectAccess>;
};

/**
 * Lazy on purpose. `allowedProjects` reads every membership from Aurora, so
 * resolving eagerly would put a paginated read under `/health` and `/v1/me`,
 * which have no project at all.
 */
export function createProjectGuard(input: {
  service: TraceService;
  human: HumanIdentity | null;
  actor: AuthActor | undefined;
}): ProjectGuard {
  let principal: Promise<Principal> | null = null;
  let access: Promise<ProjectAccess> | null = null;

  const guard: ProjectGuard = {
    principal() {
      principal ??= resolvePrincipal(input);
      return principal;
    },
    access() {
      access ??= guard.principal().then((p) => allowedProjects(input.service, p));
      return access;
    },
  };
  return guard;
}

/** Puts the guard in the request context. Costs nothing until a route asks. */
export function projectGuardMiddleware(deps: {
  service: TraceService;
  resolveHuman: (c: Context<{ Variables: AppVariables }>) => HumanIdentity | null;
}) {
  return async (c: Context<{ Variables: AppVariables }>, next: Next) => {
    c.set(
      "projectGuard",
      createProjectGuard({
        service: deps.service,
        human: deps.resolveHuman(c),
        actor: c.get("actor"),
      }),
    );
    await next();
  };
}

/**
 * Returns a 404 response when this request may not see `projectSlug`, or null
 * when it may. Empty slug is not an access question — the route decides whether
 * that is a 400.
 *
 * `notFoundMessage` must match what the route says for a resource that truly
 * does not exist. TRA-81 F3 is an information requirement, not just a status
 * code: answering "Project not found" where a missing ticket would say "Ticket
 * not found" still tells the caller that this ticket exists.
 */
export async function denyUnlessProjectVisible(
  c: Context<{ Variables: AppVariables }>,
  projectSlug: string | null | undefined,
  notFoundMessage = "Project not found",
): Promise<Response | null> {
  const slug = projectSlug?.trim();
  if (!slug) return null;

  const guard = c.get("projectGuard");
  if (!guard) {
    // Deny by default. Reaching this means the middleware is not mounted, which
    // the guard test is there to prevent; failing open would turn a wiring
    // mistake into a silent leak.
    console.error(
      "[project-guard] no guard in context; denying access to be safe",
    );
    return c.json({ message: notFoundMessage, code: "NOT_FOUND" }, 404);
  }

  const access = await guard.access();
  if (mayAccessProject(access, slug)) return null;
  return c.json({ message: notFoundMessage, code: "NOT_FOUND" }, 404);
}

/**
 * Filters a cross-project list down to what this access allows, keeping items
 * that belong to no project at all.
 *
 * That last part is not a detail: `listWorkflows()` without a project filter
 * also returns workflows with an empty project field (`traceai-default`). They
 * belong to nobody, so a naive `mayAccessProject(access, item.project)` would
 * hide them from everyone — an outage that has nothing to do with access.
 */
export function visibleForAccess<T>(
  access: ProjectAccess,
  items: T[],
  projectOf: (item: T) => string | null | undefined,
): T[] {
  return items.filter((item) => {
    const slug = projectOf(item)?.trim();
    if (!slug) return true;
    return mayAccessProject(access, slug);
  });
}
