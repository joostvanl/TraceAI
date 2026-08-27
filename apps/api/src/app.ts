import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { timingSafeEqual } from "node:crypto";
import type { TraceService } from "@traceai/core";
import { hasScope, isWritableAgentApiProvider, type AuthStore } from "@traceai/auth";
import {
  AuroraApiError,
  AuroraNetworkError,
  computeTokenRollup,
  ExpectedStateRequiredError,
  HumanGateOpenError,
  isProjectRole,
  membershipSlug,
  parseWorkflowDocument,
  relationSlug,
  requiredRoleForAction,
  claimedAgentKind,
  parseClaimedAgentId,
  scheduleClaimedCloudNudges,
  StageConflictError,
  TICKET_REVIEW_STATES,
  TraceError,
  ValidationError,
  WorkflowValidationError,
  wikiLogicalSlug,
  type CursorCloudFollowUp,
  type FieldEdit,
  type ProjectRole,
  type Ticket,
} from "@traceai/core";
import {
  eventSubscriberCount,
  getEventsAfter,
  latestEventId,
  publishTicketEvent,
  subscribeTicketEvents,
  ticketEventFromMapped,
} from "./events.js";
import {
  metricsContentType,
  observeHttp,
  observeTokensUsed,
  observeWikiWrite,
  renderMetrics,
  setSupportGauges,
  snapshotFromService,
} from "./metrics.js";
import {
  attributionName,
  HUMAN_IDENTITY_HEADER,
  parseHumanIdentityHeader,
  type HumanIdentity,
} from "./human-identity.js";
import {
  audit,
  createAuthMiddleware,
  requireScope,
  requestIdMiddleware,
  type AppVariables,
} from "./middleware.js";
import { mountTraceAiMcp } from "./mcp.js";
import {
  allowedProjects,
  mayAccessProject,
  resolvePrincipal,
  type Principal,
} from "./principal.js";
import {
  denyUnlessProjectVisible,
  projectGuardMiddleware,
  visibleForAccess,
} from "./project-guard.js";
import { getNotificationStore } from "./notifications.js";
import {
  enqueueBusyCloudNudgeForVerdict,
  getNudgeQueueStore,
  type NudgeQueueStore,
} from "./nudge-queue.js";
import {
  resolveSelfServiceAuthUser,
  sanitizeSelfServiceScopes,
} from "./self-service-tokens.js";
import {
  agentApiEncryptionSecret,
  cursorFollowUpForClaimer,
  listedAgentApiProviders,
} from "./agent-api-keys.js";
import { claimAndNudgeDefaultAgentOnCreate } from "./default-agent.js";

const HUMAN_PROXY_HEADER = "x-traceai-human-proxy";

function humanProxySecret(): string | null {
  const value = process.env.TRACEAI_HUMAN_PROXY_SECRET?.trim();
  return value || null;
}

function sessionSecret(): string | null {
  const value = process.env.TRACEAI_SESSION_SECRET?.trim();
  return value || null;
}

/** True when the web session proxy presents the shared human-gate secret. */
function isHumanProxyRequest(c: {
  req: { header: (name: string) => string | undefined };
}): boolean {
  const expected = humanProxySecret();
  if (!expected) return false;
  const provided = c.req.header(HUMAN_PROXY_HEADER)?.trim() ?? "";
  if (!provided || provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(provided, "utf8"),
      Buffer.from(expected, "utf8"),
    );
  } catch {
    return false;
  }
}

function resolveHumanIdentity(c: {
  req: { header: (name: string) => string | undefined };
}): HumanIdentity | null {
  if (!isHumanProxyRequest(c)) return null;
  return parseHumanIdentityHeader(
    c.req.header(HUMAN_IDENTITY_HEADER),
    sessionSecret(),
  );
}

/**
 * Role check for whoever is acting — human or agent token (TRA-82).
 *
 * This used to start with `if (!identity) return null; // scopes already
 * checked`, which meant agent tokens skipped role checks entirely: a token
 * belonging to a `viewer` could manage memberships. Scopes say what kind of call
 * a token may make; they say nothing about roles inside a project.
 *
 * Two behaviour changes ride along, both intended:
 * - the `admin` scope escape lives *here* now, so exactly one place can override
 *   a role denial. Having it in two places is how the agent hole survived.
 * - a legacy shared login is no longer an implicit platform admin for roles.
 *   TRA-81 removed that for membership; `resolvePrincipal` reports
 *   `isPlatformAdmin: false` for legacy, so it now applies to roles too.
 */
async function enforceProjectRole(
  service: TraceService,
  principal: Principal,
  projectSlug: string,
  required: ProjectRole,
): Promise<string | null> {
  if (principal.hasAdminScope) return null;
  // Deny by default: no resolvable user means no role, so no write.
  if (!principal.userSlug) return "Forbidden";
  try {
    await service.assertProjectRole({
      projectSlug,
      userSlug: principal.userSlug,
      isPlatformAdmin: principal.isPlatformAdmin,
      required,
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Forbidden";
  }
}

/**
 * The principal for this request. Prefers what the project-access middleware
 * already resolved, then the lazy guard; both are memoized, so asking twice in
 * one request costs one lookup.
 */
async function principalFor(
  c: Context<{ Variables: AppVariables }>,
  service: TraceService,
): Promise<Principal> {
  const existing = c.get("principal");
  if (existing) return existing;
  const guard = c.get("projectGuard");
  if (guard) return guard.principal();
  return resolvePrincipal({
    service,
    human: resolveHumanIdentity(c),
    actor: c.get("actor"),
  });
}

async function notifyReviewRequested(
  service: TraceService,
  ticket: Ticket,
  options: { excludeRecipient?: string | null; type?: "review_requested" | "review_cascaded" },
) {
  const project = await service.getProject(ticket.fields.project);
  const stage = project?.stages.find((s) => s.key === ticket.fields.stage);
  if (!stage?.agent?.require_human_approval_on_exit) return;

  const store = getNotificationStore();
  const recipients = await service.listReviewNotificationRecipients(
    ticket.fields.project,
  );
  const deeplink = `/inbox#${ticket.slug}`;
  for (const recipient of recipients) {
    if (options.excludeRecipient && recipient === options.excludeRecipient) {
      continue;
    }
    store.notify({
      recipient,
      type: options.type ?? "review_requested",
      project: ticket.fields.project,
      ticket_slug: ticket.slug,
      ticket_key: ticket.fields.ticket_key ?? null,
      title: ticket.fields.title,
      stage: ticket.fields.stage,
      deeplink,
    });
  }
}

/**
 * Project slugs this request may touch. Replaces the old `projectsForHuman`:
 * memberships now apply to agent tokens too, and a legacy login is no longer an
 * implicit platform admin (TRA-81).
 */
async function accessibleProjectSlugs(
  service: TraceService,
  principal: Principal,
): Promise<string[]> {
  const access = await allowedProjects(service, principal);
  if (access === "all") {
    return (await service.listProjects()).map((p) => p.slug);
  }
  return [...access];
}

function mapTraceaiUser(
  u: Awaited<ReturnType<TraceService["listTraceaiUsers"]>>[number],
) {
  return {
    slug: u.slug,
    username: u.fields.username,
    display_name: u.fields.display_name,
    email: u.fields.email ?? null,
    status: u.fields.status,
    is_platform_admin: u.fields.is_platform_admin === true,
    password_set:
      typeof u.fields.password === "object" &&
      u.fields.password !== null &&
      (u.fields.password as { set?: unknown }).set === true,
  };
}

function mapMembership(
  m: Awaited<ReturnType<TraceService["listProjectMemberships"]>>[number],
) {
  return {
    slug: m.slug,
    project: m.fields.project,
    user: m.fields.user,
    role: m.fields.role,
  };
}

function param(c: { req: { param: (k: string) => string | undefined } }, key: string): string {
  const value = c.req.param(key);
  if (!value) throw new ValidationError(`Missing path param: ${key}`);
  return value;
}

function mapProject(p: Awaited<ReturnType<TraceService["listProjects"]>>[number]) {
  return {
    slug: p.slug,
    name: p.fields.name,
    description: p.fields.description ?? "",
    default_workflow: p.fields.default_workflow ?? null,
    project_key: p.fields.project_key ?? null,
  };
}

function mapTicket(t: NonNullable<
  Awaited<ReturnType<TraceService["getTicket"]>>
>["ticket"]) {
  return {
    slug: t.slug,
    ticket_key: t.fields.ticket_key ?? null,
    ticket_number: t.fields.ticket_number ?? null,
    title: t.fields.title,
    description: t.fields.description ?? "",
    project: t.fields.project,
    workflow: t.fields.workflow,
    stage: t.fields.stage,
    priority: t.fields.priority ?? "medium",
    created_by: t.fields.created_by ?? null,
    stage_entered_at: t.fields.stage_entered_at ?? null,
    tokens_estimate: t.fields.tokens_estimate ?? null,
    tokens_actual: t.fields.tokens_actual ?? null,
    resolution: t.fields.resolution ?? null,
    review_state: t.fields.review_state || null,
    review_by: t.fields.review_by || null,
    review_at: t.fields.review_at || null,
    parent: t.fields.parent || null,
    sort_order: t.fields.sort_order ?? null,
    claimed_agent_id: t.fields.claimed_agent_id?.trim() || null,
    claimed_agent_kind: claimedAgentKind(t.fields.claimed_agent_id),
    claimed_by_user_id: t.fields.claimed_by_user_id?.trim() || null,
  };
}

function mapTicketSummary(
  t: NonNullable<Awaited<ReturnType<TraceService["getTicket"]>>>["ticket"],
) {
  return {
    slug: t.slug,
    ticket_key: t.fields.ticket_key ?? null,
    title: t.fields.title,
    stage: t.fields.stage,
    tokens_estimate: t.fields.tokens_estimate ?? null,
    tokens_actual: t.fields.tokens_actual ?? null,
    parent: t.fields.parent || null,
  };
}

function mapWorkflow(w: Awaited<ReturnType<TraceService["listWorkflows"]>>[number]) {
  return {
    slug: w.slug,
    name: w.fields.name,
    project: w.fields.project,
  };
}

function mapWikiPage(
  p: Awaited<ReturnType<TraceService["listWikiPages"]>>["items"][number],
  options: { includeBody?: boolean } = {},
) {
  // Listings omit the body on purpose: with every page's Markdown inline the
  // response outgrows an agent's context. Use GET /v1/wiki-pages/:slug for it.
  const withBody = options.includeBody ?? true;
  return {
    slug: p.slug,
    title: p.fields.title,
    ...(withBody ? { body: p.fields.body ?? "" } : {}),
    project: p.fields.project,
    parent: p.fields.parent ?? null,
    sort_order: p.fields.sort_order ?? null,
    updated_by: p.fields.updated_by ?? null,
    updatedAt: p.updatedAt,
  };
}

/** Validate an `edits` payload before it reaches Aurora. */
function parseFieldEdits(
  raw: unknown,
): { edits: FieldEdit[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      error: "edits must be a non-empty array of { old_string, new_string }.",
    };
  }
  const edits: FieldEdit[] = [];
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object") {
      return { error: `edits[${i}] must be an object.` };
    }
    const edit = item as Record<string, unknown>;
    if (typeof edit.old_string !== "string" || !edit.old_string) {
      return { error: `edits[${i}].old_string must be a non-empty string.` };
    }
    if (typeof edit.new_string !== "string") {
      return { error: `edits[${i}].new_string must be a string.` };
    }
    if (
      edit.replace_all !== undefined &&
      typeof edit.replace_all !== "boolean"
    ) {
      return { error: `edits[${i}].replace_all must be a boolean.` };
    }
    edits.push({
      old_string: edit.old_string,
      new_string: edit.new_string,
      ...(edit.replace_all !== undefined
        ? { replace_all: edit.replace_all }
        : {}),
    });
  }
  return { edits };
}

/** Aurora statuses that are expected outcomes, not server faults. */
function isPassThroughStatus(status: number): status is 400 | 409 {
  return status === 400 || status === 409;
}

/** Keep Aurora's own message, code and issues so the agent can act on them. */
function auroraErrorBody(error: AuroraApiError) {
  const body = (error.body ?? {}) as Record<string, unknown>;
  return {
    message: typeof body.message === "string" ? body.message : error.message,
    code:
      typeof body.code === "string"
        ? body.code
        : error.status === 409
          ? "CONFLICT"
          : "VALIDATION_FAILED",
    ...(Array.isArray(body.issues) ? { issues: body.issues } : {}),
    ...(typeof body.requestId === "string"
      ? { aurora_request_id: body.requestId }
      : {}),
  };
}

function corsOrigins(): string[] {
  const fromEnv = (process.env.TRACEAI_CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3010",
    "http://127.0.0.1:3010",
    ...fromEnv,
  ];
}

function httpRouteLabel(c: Context): string {
  const routes = c.req.matchedRoutes;
  for (let i = routes.length - 1; i >= 0; i--) {
    const path = routes[i]?.path;
    if (path && path !== "*" && path !== "/*") return path;
  }
  const routePath = c.req.routePath;
  if (routePath && routePath !== "*" && routePath !== "/*") return routePath;
  return "unmatched";
}

export function createApp(deps: {
  authStore: AuthStore;
  service: TraceService;
  cursorCloud?: CursorCloudFollowUp | ((ticket: Ticket) => CursorCloudFollowUp | null) | null;
  cursorCloudFetch?: typeof fetch;
  scheduleWakeup?: (fn: () => void) => void;
  nudgeQueue?: NudgeQueueStore | null;
  now?: () => Date;
}) {
  const app = new Hono<{ Variables: AppVariables }>();
  const auth = createAuthMiddleware(deps.authStore);
  // Live path: per-claimer Cursor key (TRA-114). Never CURSOR_API_KEY / fromEnv().
  // Tests may inject a shared client; `null` skips wake-up entirely.
  const cursorCloud =
    deps.cursorCloud !== undefined
      ? deps.cursorCloud
      : (ticket: Ticket) =>
          cursorFollowUpForClaimer(deps.authStore, ticket, {
            fetchImpl: deps.cursorCloudFetch,
          });
  const nudgeQueue =
    deps.nudgeQueue === undefined ? getNudgeQueueStore() : deps.nudgeQueue;
  const now = deps.now ?? (() => new Date());

  app.use(
    "*",
    cors({
      origin: corsOrigins(),
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Authorization",
        "Content-Type",
        "Accept",
        "x-request-id",
        "mcp-session-id",
        "mcp-protocol-version",
        "last-event-id",
      ],
      exposeHeaders: ["x-request-id", "mcp-session-id"],
    }),
  );

  app.use("*", requestIdMiddleware());

  app.use("*", async (c, next) => {
    const started = performance.now();
    await next();
    observeHttp({
      method: c.req.method,
      route: httpRouteLabel(c),
      status: c.res.status,
      seconds: (performance.now() - started) / 1000,
    });
  });

  app.get("/health", (c) => c.json({ status: "ok", service: "traceai-api" }));

  app.get("/metrics", async (c) => {
    try {
      await snapshotFromService(deps.service);
    } catch {
      // Board gauges stay at the last successful snapshot.
    }
    setSupportGauges({
      subscribers: eventSubscriberCount(),
      latestId: latestEventId(),
    });
    const body = await renderMetrics();
    return c.body(body, 200, { "Content-Type": metricsContentType() });
  });

  // Hosted MCP (Streamable HTTP) — Cursor remote config needs only URL + Bearer.
  // Mounted outside `/v1/*` so auth errors stay MCP/HTTP-native; still requires trc_….
  mountTraceAiMcp(app, deps.authStore);

  // SSE stream for live boards. Authenticated: same principal as `/v1/*`.
  // Browser EventSource cannot send Authorization, so the web UI reaches
  // this via same-origin `GET /api/events` (TRA-84). Resume via
  // `Last-Event-ID` / `?after=<event_id>` still applies — replay is filtered
  // to projects the caller may see.
  app.use("/events", auth);
  app.use(
    "/events",
    projectGuardMiddleware({
      service: deps.service,
      resolveHuman: resolveHumanIdentity,
    }),
  );
  app.get("/events", async (c) => {
    const projectFilter = c.req.query("project")?.trim() || undefined;
    const principal = await principalFor(c, deps.service);
    const isAdmin = principal.isPlatformAdmin || principal.hasAdminScope;
    if (!isAdmin && !projectFilter) {
      return c.json({ message: "project is required", code: "VALIDATION" }, 400);
    }
    if (projectFilter) {
      const hidden = await denyUnlessProjectVisible(c, projectFilter);
      if (hidden) return hidden;
    }

    const afterParam =
      c.req.header("Last-Event-ID") ?? c.req.query("after") ?? undefined;
    const parsedAfter = afterParam ? Number(afterParam) : NaN;

    return streamSSE(c, async (stream) => {
      // No cursor supplied → start from "now" so a fresh board doesn't get a
      // full backlog replay (initial ticket list is loaded separately).
      let cursor = Number.isFinite(parsedAfter)
        ? Math.max(0, parsedAfter)
        : latestEventId();
      let closed = false;
      let draining = false;
      let pending = false;

      // Single ordered delivery path. Both the initial replay and live
      // notifications call drain(), which reads the store from `cursor`
      // onward, so events are never duplicated or delivered out of order —
      // even when they originate from another API process.
      async function drain() {
        if (draining) {
          pending = true;
          return;
        }
        draining = true;
        try {
          do {
            pending = false;
            const records = getEventsAfter(cursor, projectFilter);
            for (const record of records) {
              if (closed) return;
              await stream.writeSSE({
                id: String(record.event_id),
                event: record.event.type,
                data: JSON.stringify(record.event),
              });
              cursor = record.event_id;
            }
          } while (pending && !closed);
        } finally {
          draining = false;
        }
      }

      const unsubscribe = subscribeTicketEvents(() => {
        void drain();
      });

      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });

      await stream.writeSSE({
        event: "connected",
        data: JSON.stringify({
          ok: true,
          project: projectFilter ?? null,
          last_event_id: cursor,
          at: new Date().toISOString(),
        }),
      });

      // Replay anything missed since `cursor` before going live.
      await drain();

      while (!closed) {
        await stream.sleep(15000);
        if (closed) break;
        await stream.writeSSE({
          event: "ping",
          data: JSON.stringify({ at: new Date().toISOString() }),
        });
      }
    });
  });

  app.use("/v1/*", auth);

  // Project-scoped authorization for every `/v1/projects/:slug` route.
  // Deliberately middleware and not a per-route check: a route that forgets the
  // check leaks, and so does every route added later (TRA-81). The guard test in
  // project-access.guard.test.ts fails when a route escapes these patterns.
  // Resolves the principal at most once per request, lazily, for every /v1 route
  // (TRA-82). Routes whose project is not in the path have no middleware above
  // them, so this is where they get their answer from.
  app.use(
    "/v1/*",
    projectGuardMiddleware({
      service: deps.service,
      resolveHuman: resolveHumanIdentity,
    }),
  );

  const projectAccessMiddleware = async (
    c: Context<{ Variables: AppVariables }>,
    next: Next,
  ) => {
    const projectSlug = c.req.param("slug");
    if (!projectSlug) return next();
    const guard = c.get("projectGuard");
    const principal = guard
      ? await guard.principal()
      : await resolvePrincipal({
          service: deps.service,
          human: resolveHumanIdentity(c),
          actor: c.get("actor"),
        });
    const access = guard
      ? await guard.access()
      : await allowedProjects(deps.service, principal);
    if (!mayAccessProject(access, projectSlug)) {
      // 404, never 403: a 403 confirms the project exists, and whether someone
      // else's project exists is itself information.
      return c.json({ message: "Project not found", code: "NOT_FOUND" }, 404);
    }
    c.set("principal", principal);
    c.set("projectAccess", access);
    await next();
  };

  // Both patterns are needed: `/:slug/*` does not match `/v1/projects/traceai`
  // itself, and that route returns the project plus its agent_playbook.
  app.use("/v1/projects/:slug", projectAccessMiddleware);
  app.use("/v1/projects/:slug/*", projectAccessMiddleware);

  /**
   * Membership + role check for the `/v1/workflows/:slug/...` family (TRA-82).
   * Their project comes from the workflow, not the path, so there are eight
   * routes that each need the same three steps; one helper keeps them identical.
   *
   * A workflow with no project (`traceai-default`) is readable by everyone but
   * writable only with the `admin` scope: there is no project to hold a role in,
   * and deny-by-default is the safer answer for a shared resource.
   */
  const denyWorkflowAccess = async (
    c: Context<{ Variables: AppVariables }>,
    action: "read" | "write_workflow",
  ): Promise<Response | null> => {
    const existing = await deps.service.getWorkflow(param(c, "slug"));
    if (!existing) {
      return c.json({ message: "Workflow not found", code: "NOT_FOUND" }, 404);
    }
    const project = relationSlug(existing.workflow.fields.project);
    const hidden = await denyUnlessProjectVisible(
      c,
      project,
      "Workflow not found",
    );
    if (hidden) return hidden;
    if (action === "read") return null;
    const denied = await enforceProjectRole(
      deps.service,
      await principalFor(c, deps.service),
      project ?? "",
      requiredRoleForAction(action),
    );
    return denied ? c.json({ message: denied, code: "FORBIDDEN" }, 403) : null;
  };

  app.get("/v1/me", (c) => {
    const actor = c.get("actor");
    return c.json({
      user: {
        id: actor.userId,
        email: actor.email,
        name: actor.name,
      },
      tokenId: actor.tokenId,
      scopes: actor.scopes,
    });
  });

  // Self-service API tokens for personal web logins (human proxy required).
  // Ownership is derived from signed human identity — never from client userId.
  app.get("/v1/me/tokens", async (c) => {
    const human = resolveHumanIdentity(c);
    const resolved = await resolveSelfServiceAuthUser(
      deps.service,
      deps.authStore,
      human,
    );
    if (!resolved.ok) {
      return c.json(
        { message: resolved.message, code: resolved.code },
        resolved.status,
      );
    }
    return c.json({
      user: {
        id: resolved.user.id,
        email: resolved.user.email,
        name: resolved.user.name,
      },
      items: deps.authStore
        .listTokens(resolved.user.id)
        .filter((t) => !t.revokedAt),
    });
  });

  app.post("/v1/me/tokens", async (c) => {
    const human = resolveHumanIdentity(c);
    const resolved = await resolveSelfServiceAuthUser(
      deps.service,
      deps.authStore,
      human,
    );
    if (!resolved.ok) {
      return c.json(
        { message: resolved.message, code: resolved.code },
        resolved.status,
      );
    }
    const body = await c.req
      .json<{
        name?: string;
        scopes?: string[];
        expiresAt?: string | null;
      }>()
      .catch(() => ({} as { name?: string; scopes?: string[]; expiresAt?: string | null }));
    const name = body.name?.trim();
    if (!name) {
      return c.json(
        { message: "name is required", code: "VALIDATION" },
        400,
      );
    }
    const token = deps.authStore.createToken({
      userId: resolved.user.id,
      name,
      scopes: sanitizeSelfServiceScopes(body.scopes),
      expiresAt: body.expiresAt ?? null,
    });
    audit(c, {
      action: "token.create",
      resourceType: "token",
      resourceId: token.id,
      meta: {
        userId: resolved.user.id,
        uiSlug: resolved.uiSlug,
        selfService: true,
      },
    });
    return c.json(token, 201);
  });

  app.post("/v1/me/tokens/:id/revoke", async (c) => {
    const human = resolveHumanIdentity(c);
    const resolved = await resolveSelfServiceAuthUser(
      deps.service,
      deps.authStore,
      human,
    );
    if (!resolved.ok) {
      return c.json(
        { message: resolved.message, code: resolved.code },
        resolved.status,
      );
    }
    const tokenId = param(c, "id");
    const owned = deps.authStore
      .listTokens(resolved.user.id)
      .find((t) => t.id === tokenId);
    if (!owned) {
      return c.json({ message: "Token not found", code: "NOT_FOUND" }, 404);
    }
    const token = deps.authStore.revokeToken(tokenId);
    if (!token) {
      return c.json({ message: "Token not found", code: "NOT_FOUND" }, 404);
    }
    audit(c, {
      action: "token.revoke",
      resourceType: "token",
      resourceId: token.id,
      meta: {
        userId: resolved.user.id,
        uiSlug: resolved.uiSlug,
        selfService: true,
      },
    });
    return c.json(token);
  });

  app.get("/v1/me/agent-apis", async (c) => {
    const human = resolveHumanIdentity(c);
    const resolved = await resolveSelfServiceAuthUser(
      deps.service,
      deps.authStore,
      human,
    );
    if (!resolved.ok) {
      return c.json(
        { message: resolved.message, code: resolved.code },
        resolved.status,
      );
    }
    return c.json({
      items: listedAgentApiProviders(deps.authStore, resolved.user.id),
      default_cursor_agent_id: deps.authStore.getDefaultCursorAgentId(
        resolved.user.id,
      ),
    });
  });

  app.put("/v1/me/default-agent", async (c) => {
    const human = resolveHumanIdentity(c);
    let userId: string | null = null;
    if (human) {
      const resolved = await resolveSelfServiceAuthUser(
        deps.service,
        deps.authStore,
        human,
      );
      if (!resolved.ok) {
        return c.json(
          { message: resolved.message, code: resolved.code },
          resolved.status,
        );
      }
      userId = resolved.user.id;
    } else {
      const actor = c.get("actor");
      const user = deps.authStore.getUser(actor.userId);
      if (!user) {
        return c.json(
          {
            message: "Authenticated user not found",
            code: "USER_NOT_FOUND",
          },
          404,
        );
      }
      userId = user.id;
    }
    const body = await c.req
      .json<{ agent_id?: string }>()
      .catch(() => ({} as { agent_id?: string }));
    if (!("agent_id" in body) || body.agent_id === undefined) {
      return c.json(
        {
          message: "agent_id is required (empty string clears the default)",
          code: "VALIDATION",
        },
        400,
      );
    }
    const parsed = parseClaimedAgentId(body.agent_id);
    if (!parsed.ok) {
      return c.json({ message: parsed.message, code: "VALIDATION" }, 400);
    }
    const saved = deps.authStore.setDefaultCursorAgentId(userId, parsed.value);
    audit(c, {
      action: "default_agent.save",
      resourceType: "default_agent",
      resourceId: userId,
      meta: { agent_id: saved },
    });
    return c.json({ agent_id: saved });
  });

  app.put("/v1/me/agent-apis/:provider", async (c) => {
    const human = resolveHumanIdentity(c);
    const resolved = await resolveSelfServiceAuthUser(
      deps.service,
      deps.authStore,
      human,
    );
    if (!resolved.ok) {
      return c.json(
        { message: resolved.message, code: resolved.code },
        resolved.status,
      );
    }
    const provider = param(c, "provider");
    if (!isWritableAgentApiProvider(provider)) {
      return c.json(
        {
          message: "Only the Cursor provider can be saved in this version",
          code: "VALIDATION",
        },
        400,
      );
    }
    const secret = agentApiEncryptionSecret();
    if (!secret) {
      return c.json(
        {
          message:
            "Agent API encryption secret is not configured (TRACEAI_AGENT_API_SECRET or TRACEAI_SESSION_SECRET)",
          code: "NOT_CONFIGURED",
        },
        503,
      );
    }
    const body = await c.req
      .json<{ api_key?: string }>()
      .catch(() => ({} as { api_key?: string }));
    const apiKey = body.api_key?.trim() ?? "";
    if (!apiKey) {
      return c.json(
        { message: "api_key is required", code: "VALIDATION" },
        400,
      );
    }
    const saved = deps.authStore.putAgentApiKey({
      userId: resolved.user.id,
      provider,
      apiKey,
      secret,
    });
    audit(c, {
      action: "agent_api.save",
      resourceType: "agent_api_key",
      resourceId: `${resolved.user.id}:${provider}`,
      meta: {
        userId: resolved.user.id,
        uiSlug: resolved.uiSlug,
        provider,
        last4: saved.last4,
      },
    });
    return c.json(saved);
  });

  app.delete("/v1/me/agent-apis/:provider", async (c) => {
    const human = resolveHumanIdentity(c);
    const resolved = await resolveSelfServiceAuthUser(
      deps.service,
      deps.authStore,
      human,
    );
    if (!resolved.ok) {
      return c.json(
        { message: resolved.message, code: resolved.code },
        resolved.status,
      );
    }
    const provider = param(c, "provider");
    if (!isWritableAgentApiProvider(provider)) {
      return c.json(
        {
          message: "Only the Cursor provider can be removed in this version",
          code: "VALIDATION",
        },
        400,
      );
    }
    deps.authStore.deleteAgentApiKey(resolved.user.id, provider);
    audit(c, {
      action: "agent_api.delete",
      resourceType: "agent_api_key",
      resourceId: `${resolved.user.id}:${provider}`,
      meta: {
        userId: resolved.user.id,
        uiSlug: resolved.uiSlug,
        provider,
      },
    });
    return c.json({ provider, configured: false, last4: null });
  });

  // Web UI login: personal `traceai_user` entries (preferred) or legacy
  // shared `app_login`/`default`. Verify via Aurora management API.
  app.get("/v1/ui/login/status", async (c) => {
    const personal = await deps.service
      .listTraceaiUsers()
      .then((users) =>
        users.some(
          (u) =>
            u.fields.status === "active" &&
            typeof u.fields.password === "object" &&
            u.fields.password !== null &&
            (u.fields.password as { set?: unknown }).set === true,
        ),
      )
      .catch(() => false);
    const configured = await deps.service.isUiLoginConfigured();
    return c.json({
      configured,
      mode: personal ? ("personal" as const) : configured ? ("legacy" as const) : ("none" as const),
    });
  });

  app.post("/v1/ui/login/verify", async (c) => {
    const body = await c.req.json<{
      username?: string;
      password?: string;
    }>();
    const username = body?.username?.trim() ?? "";
    const password = body?.password ?? "";
    if (!username || !password) {
      return c.json(
        { message: "username and password are required", code: "VALIDATION" },
        400,
      );
    }

    const result = await deps.service.verifyUiLogin(username, password);
    if (!result.ok) {
      if (result.reason === "not_configured") {
        return c.json(
          {
            message:
              "UI login is not configured. Create a TraceAI user in the admin UI, or set legacy app_login / default.",
            code: "NOT_CONFIGURED",
          },
          503,
        );
      }
      return c.json(
        { message: "Invalid username or password", code: "UNAUTHORIZED" },
        401,
      );
    }

    audit(c, {
      action: "ui.login.verify",
      resourceType: result.identity.mode === "personal" ? "traceai_user" : "app_login",
      resourceId: result.identity.slug ?? "default",
      meta: { mode: result.identity.mode },
    });
    return c.json({
      ok: true as const,
      user: result.user,
      identity: result.identity,
    });
  });

  // Cross-project list: the `:slug` middleware cannot help here, so filter
  // explicitly. Agent tokens see their user's projects, not every project.
  app.get("/v1/projects", requireScope("projects:read"), async (c) => {
    const access = await allowedProjects(
      deps.service,
      await resolvePrincipal({
        service: deps.service,
        human: resolveHumanIdentity(c),
        actor: c.get("actor"),
      }),
    );
    const projects = (await deps.service.listProjects()).filter((p) =>
      mayAccessProject(access, p.slug),
    );
    return c.json(projects.map(mapProject));
  });

  // Kept as the web-facing alias; same filtering as /v1/projects.
  app.get("/v1/me/projects", requireScope("projects:read"), async (c) => {
    const human = resolveHumanIdentity(c);
    if (!human) {
      return c.json(
        { message: "Human identity required", code: "UNAUTHORIZED" },
        401,
      );
    }
    const access = await allowedProjects(
      deps.service,
      await resolvePrincipal({ service: deps.service, human, actor: c.get("actor") }),
    );
    const projects = (await deps.service.listProjects()).filter((p) =>
      mayAccessProject(access, p.slug),
    );
    return c.json(projects.map(mapProject));
  });

  app.get("/v1/projects/:slug", requireScope("projects:read"), async (c) => {
    const result = await deps.service.getProject(param(c, "slug"));
    if (!result) {
      return c.json({ message: "Project not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({
      ...mapProject(result.project),
      agent_playbook: result.workflow_document
        ? {
            summary: result.workflow_document.agent_policy.summary,
            agent_policy: result.workflow_document.agent_policy,
            stages: result.workflow_document.stages,
          }
        : null,
      default_workflow: result.workflow
        ? {
            slug: result.workflow.slug,
            name: result.workflow.fields.name,
            stages: result.stages,
            agent_policy: result.workflow_document?.agent_policy ?? null,
          }
        : null,
    });
  });

  app.post("/v1/projects", requireScope("projects:write"), async (c) => {
    const body = await c.req.json<{
      name: string;
      description?: string;
      slug?: string;
      seed_workflow?: boolean;
      seed_wiki?: boolean;
      owner_user?: string;
    }>();
    if (!body?.name?.trim()) {
      return c.json({ message: "name is required", code: "VALIDATION" }, 400);
    }
    const human = resolveHumanIdentity(c);
    // The owner membership is what grants access to the new project (TRA-81 F2),
    // so it has to be derived for agent tokens too — otherwise a token creates a
    // project it can no longer see. resolvePrincipal maps the token back to its
    // TraceAI user; a legacy human still has no personal slug and gets none.
    const principal = await resolvePrincipal({
      service: deps.service,
      human,
      actor: c.get("actor"),
    });
    const ownerUser =
      body.owner_user?.trim() ||
      (human
        ? human.slug && human.mode === "personal"
          ? human.slug
          : undefined
        : (principal.userSlug ?? undefined));
    const result = await deps.service.createProject({
      name: body.name,
      description: body.description,
      slug: body.slug,
      seedWorkflow: body.seed_workflow,
      seedWiki: body.seed_wiki,
      ownerUser,
    });
    audit(c, {
      action: "project.create",
      resourceType: "project",
      resourceId: result.project.slug,
    });
    if (ownerUser) {
      audit(c, {
        action: "project_membership.set",
        resourceType: "project_membership",
        resourceId: `${result.project.slug}:${ownerUser}`,
      });
    }
    return c.json(
      {
        project: mapProject(result.project),
        workflow: result.workflow ? mapWorkflow(result.workflow) : null,
        wiki_pages: result.wiki_pages.map((p) => ({
          slug: p.slug,
          title: p.fields.title,
          logical_slug: wikiLogicalSlug(p.slug, result.project.slug),
        })),
      },
      201,
    );
  });

  app.patch("/v1/projects/:slug", requireScope("projects:write"), async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ message: "Invalid JSON body", code: "VALIDATION" }, 400);
    }
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== "default_workflow") {
      return c.json(
        {
          message: "Only default_workflow may be updated",
          code: "VALIDATION",
        },
        400,
      );
    }
    if (
      typeof body.default_workflow !== "string" ||
      !body.default_workflow.trim()
    ) {
      return c.json(
        { message: "default_workflow is required", code: "VALIDATION" },
        400,
      );
    }
    const project = param(c, "slug");
    const denied = await enforceProjectRole(
      deps.service,
      await principalFor(c, deps.service),
      project,
      requiredRoleForAction("write_workflow"),
    );
    if (denied) {
      return c.json({ message: denied, code: "FORBIDDEN" }, 403);
    }
    const updated = await deps.service.setProjectDefaultWorkflow(
      project,
      body.default_workflow.trim(),
    );
    audit(c, {
      action: "project.update_default_workflow",
      resourceType: "project",
      resourceId: project,
      meta: { default_workflow: updated.fields.default_workflow },
    });
    return c.json(mapProject(updated));
  });

  app.get(
    "/v1/projects/:slug/search",
    requireScope("tickets:read"),
    async (c) => {
      const slug = param(c, "slug");
      const actor = c.get("actor");
      const includeWiki = hasScope(actor.scopes, "wiki:read");
      const typeParam = c.req.query("type");
      const type =
        typeParam === "ticket" || typeParam === "wiki_page" || typeParam === "all"
          ? typeParam
          : "all";
      const profileParam = c.req.query("profile");
      const profile =
        profileParam === "focused" ||
        profileParam === "balanced" ||
        profileParam === "broad"
          ? profileParam
          : "balanced";
      const limitParam = c.req.query("limit");
      const limit = limitParam == null ? undefined : Number(limitParam);
      const offset = Number(c.req.query("offset") ?? 0);
      const page = await deps.service.searchProject({
        project: slug,
        includeWiki: includeWiki && type !== "ticket",
        profile,
        includePreview: c.req.query("include_preview") !== "false",
        limit,
        offset,
        filters: {
          q: c.req.query("q") ?? undefined,
          type: includeWiki ? type : "ticket",
          stage: c.req.query("stage") ?? undefined,
          resolution: c.req.query("resolution") ?? undefined,
          priority: c.req.query("priority") ?? undefined,
          created_by:
            c.req.query("created_by") ?? c.req.query("actor") ?? undefined,
          from: c.req.query("from") ?? undefined,
          to: c.req.query("to") ?? undefined,
        },
      });
      return c.json(page);
    },
  );

  app.get(
    "/v1/projects/:slug/history",
    requireScope("tickets:read"),
    async (c) => {
      const slug = param(c, "slug");
      const stage = c.req.query("stage") ?? undefined;
      const limit = Number(c.req.query("limit") ?? 25);
      const offset = Number(c.req.query("offset") ?? 0);
      const page = await deps.service.listTicketHistory({
        project: slug,
        stage,
        limit,
        offset,
      });
      return c.json({
        items: page.items.map(({ ticket: t }) => ({
          slug: t.slug,
          ticket_key: t.fields.ticket_key ?? null,
          ticket_number: t.fields.ticket_number ?? null,
          title: t.fields.title,
          stage: t.fields.stage,
          priority: t.fields.priority ?? "medium",
          created_by: t.fields.created_by ?? null,
          stage_entered_at: t.fields.stage_entered_at ?? null,
          tokens_estimate: t.fields.tokens_estimate ?? null,
          tokens_actual: t.fields.tokens_actual ?? null,
          resolution: t.fields.resolution ?? null,
        })),
        total: page.total,
        limit: page.limit,
        offset: page.offset,
      });
    },
  );

  app.get(
    "/v1/projects/:slug/insights",
    requireScope("tickets:read"),
    async (c) => {
      const slug = param(c, "slug");
      const insights = await deps.service.getProjectInsights(slug);
      return c.json({ project: slug, ...insights });
    },
  );

  app.get(
    "/v1/projects/:slug/estimate-vs-actual",
    requireScope("tickets:read"),
    async (c) => {
      const slug = param(c, "slug");
      const limitRaw = c.req.query("limit");
      const breakpointsRaw = c.req.query("breakpoints");
      const limit =
        limitRaw == null || limitRaw === "" ? undefined : Number(limitRaw);
      const breakpoints =
        breakpointsRaw == null || breakpointsRaw.trim() === ""
          ? undefined
          : breakpointsRaw.split(",").map((part) => Number(part.trim()));
      const result = await deps.service.getEstimateVsActual(slug, {
        limit,
        breakpoints,
      });
      return c.json({ project: slug, ...result });
    },
  );

  app.get("/v1/tickets", requireScope("tickets:read"), async (c) => {
    const project = c.req.query("project");
    if (!project) {
      return c.json(
        { message: "project query param is required", code: "VALIDATION" },
        400,
      );
    }
    const hidden = await denyUnlessProjectVisible(c, project);
    if (hidden) return hidden;
    const stage = c.req.query("stage") ?? undefined;
    const workflow = c.req.query("workflow") || undefined;
    const parentRaw = c.req.query("parent");
    const parent =
      parentRaw === undefined
        ? undefined
        : parentRaw === "" || parentRaw === "null"
          ? null
          : parentRaw;
    // Load the full project set so roll-ups include descendants even when
    // the response is filtered by stage/parent/workflow.
    const projectTickets = await deps.service.listTickets({ project });
    const tickets = projectTickets
      .filter((t) => (stage ? t.fields.stage === stage : true))
      .filter((t) => {
        if (parent === undefined) return true;
        const value = t.fields.parent || null;
        if (parent === null) return value == null || value === "";
        return value === parent;
      })
      .filter((t) => (workflow ? t.fields.workflow === workflow : true));
    return c.json(
      tickets.map((t) => {
        const rollup = computeTokenRollup(projectTickets, t.slug);
        return {
          slug: t.slug,
          ticket_key: t.fields.ticket_key ?? null,
          ticket_number: t.fields.ticket_number ?? null,
          title: t.fields.title,
          stage: t.fields.stage,
          priority: t.fields.priority ?? "medium",
          workflow: t.fields.workflow,
          created_by: t.fields.created_by ?? null,
          stage_entered_at: t.fields.stage_entered_at ?? null,
          tokens_estimate: t.fields.tokens_estimate ?? null,
          tokens_actual: t.fields.tokens_actual ?? null,
          tokens_estimate_rollup: rollup.tokens_estimate_rollup,
          tokens_actual_rollup: rollup.tokens_actual_rollup,
          resolution: t.fields.resolution ?? null,
          review_state: t.fields.review_state || null,
          review_by: t.fields.review_by || null,
          review_at: t.fields.review_at || null,
          parent: t.fields.parent || null,
          sort_order: t.fields.sort_order ?? null,
          claimed_agent_id: t.fields.claimed_agent_id?.trim() || null,
          claimed_agent_kind: claimedAgentKind(t.fields.claimed_agent_id),
          claimed_by_user_id: t.fields.claimed_by_user_id?.trim() || null,
        };
      }),
    );
  });

  app.get("/v1/tickets/:slug", requireScope("tickets:read"), async (c) => {
    const result = await deps.service.getTicket(param(c, "slug"));
    if (!result) {
      return c.json({ message: "Ticket not found", code: "NOT_FOUND" }, 404);
    }
    // Same message and status as a ticket that does not exist, so the answer
    // does not reveal that this one does (TRA-81 F3).
    const hidden = await denyUnlessProjectVisible(
      c,
      result.ticket.fields.project,
      "Ticket not found",
    );
    if (hidden) return hidden;
    return c.json({
      ...mapTicket(result.ticket),
      tokens_estimate_rollup: result.tokens_estimate_rollup,
      tokens_actual_rollup: result.tokens_actual_rollup,
      parent_ticket: result.parent_ticket
        ? mapTicketSummary(result.parent_ticket)
        : null,
      children: result.children.map(mapTicketSummary),
      comments: result.comments.map((comment) => ({
        slug: comment.slug,
        author: comment.fields.author ?? null,
        body: comment.fields.body,
        createdAt: comment.createdAt,
      })),
    });
  });

  app.post("/v1/tickets", requireScope("tickets:write"), async (c) => {
    const actor = c.get("actor");
    const human = resolveHumanIdentity(c);
    const body = await c.req.json<{
      project: string;
      title: string;
      description?: string;
      priority?: string;
      workflow?: string;
      stage?: string;
      slug?: string;
      parent?: string | null;
      created_by?: string;
    }>();
    if (!body?.project || !body?.title?.trim()) {
      return c.json(
        { message: "project and title are required", code: "VALIDATION" },
        400,
      );
    }
    const hidden = await denyUnlessProjectVisible(c, body.project);
    if (hidden) return hidden;
    const denied = await enforceProjectRole(
      deps.service,
      await principalFor(c, deps.service),
      body.project,
      requiredRoleForAction("write_tickets"),
    );
    if (denied) {
      return c.json({ message: denied, code: "FORBIDDEN" }, 403);
    }
    const ticket = await deps.service.createTicket({
      project: body.project,
      title: body.title,
      description: body.description,
      priority: body.priority,
      workflow: body.workflow,
      stage: body.stage,
      slug: body.slug,
      parent: body.parent,
      created_by: attributionName(human, body.created_by?.trim() || actor.name),
    });
    let ownerUserId: string | null = null;
    if (human?.mode === "personal") {
      try {
        const resolved = await resolveSelfServiceAuthUser(
          deps.service,
          deps.authStore,
          human,
        );
        if (resolved.ok) ownerUserId = resolved.user.id;
      } catch (error) {
        console.warn("[traceai] default-agent owner join failed", error);
      }
    } else if (!human) {
      ownerUserId = actor.userId;
    }
    const maybeClaimed = await claimAndNudgeDefaultAgentOnCreate({
      ticket,
      ownerUserId,
      authStore: deps.authStore,
      service: deps.service,
      cursorCloud: deps.cursorCloud !== undefined ? cursorCloud : undefined,
      cursorCloudFetch: deps.cursorCloudFetch,
      scheduleWakeup: deps.scheduleWakeup,
      nudgeQueue,
      now,
    });
    const mapped = mapTicket(maybeClaimed);
    publishTicketEvent(ticketEventFromMapped("ticket.created", mapped));
    audit(c, {
      action: "ticket.create",
      resourceType: "ticket",
      resourceId: ticket.slug,
      meta: human ? { human: human.user, human_slug: human.slug } : undefined,
    });
    return c.json(mapped, 201);
  });

  app.patch("/v1/tickets/:slug", requireScope("tickets:write"), async (c) => {
    const body = await c.req.json<{
      title?: string;
      description?: string;
      priority?: string;
      tokens_estimate?: number;
      sort_order?: number;
      resolution?: string;
      parent?: string | null;
      workflow?: string;
    }>();
    // Load first: the project of the ticket is what decides both checks, and
    // this route had neither before TRA-82.
    const existing = await deps.service.getTicket(param(c, "slug"));
    if (!existing) {
      return c.json({ message: "Ticket not found", code: "NOT_FOUND" }, 404);
    }
    const project = existing.ticket.fields.project;
    const hidden = await denyUnlessProjectVisible(c, project, "Ticket not found");
    if (hidden) return hidden;
    const denied = await enforceProjectRole(
      deps.service,
      await principalFor(c, deps.service),
      project,
      requiredRoleForAction("write_tickets"),
    );
    if (denied) {
      return c.json({ message: denied, code: "FORBIDDEN" }, 403);
    }
    const human = resolveHumanIdentity(c);
    const actor = c.get("actor");
    const ticket = await deps.service.updateTicket(param(c, "slug"), {
      ...body,
      author: attributionName(human, actor.name),
    });
    const mapped = mapTicket(ticket);
    publishTicketEvent(ticketEventFromMapped("ticket.updated", mapped));
    audit(c, {
      action: "ticket.update",
      resourceType: "ticket",
      resourceId: ticket.slug,
    });
    return c.json(mapped);
  });

  app.post("/v1/tickets/:slug/claim", requireScope("tickets:write"), async (c) => {
    const existing = await deps.service.getTicket(param(c, "slug"));
    if (!existing) {
      return c.json({ message: "Ticket not found", code: "NOT_FOUND" }, 404);
    }
    const project = existing.ticket.fields.project;
    const hidden = await denyUnlessProjectVisible(c, project, "Ticket not found");
    if (hidden) return hidden;
    const denied = await enforceProjectRole(
      deps.service,
      await principalFor(c, deps.service),
      project,
      requiredRoleForAction("write_tickets"),
    );
    if (denied) {
      return c.json({ message: denied, code: "FORBIDDEN" }, 403);
    }
    const body = await c.req.json<{ agent_id?: string | null }>();
    if (!("agent_id" in (body ?? {})) || body.agent_id === undefined) {
      return c.json(
        { message: "agent_id is required (empty string clears the claim)", code: "VALIDATION" },
        400,
      );
    }
    const actor = c.get("actor");
    const ticket = await deps.service.claimTicket(
      param(c, "slug"),
      body.agent_id,
      actor.userId,
    );
    const mapped = mapTicket(ticket);
    publishTicketEvent(ticketEventFromMapped("ticket.updated", mapped));
    audit(c, {
      action: "ticket.claim",
      resourceType: "ticket",
      resourceId: ticket.slug,
      meta: {
        claimed_agent_id: mapped.claimed_agent_id,
        claimed_agent_kind: mapped.claimed_agent_kind,
        claimed_by_user_id: mapped.claimed_by_user_id,
      },
    });
    return c.json(mapped);
  });

  app.post("/v1/tickets/reorder", requireScope("tickets:write"), async (c) => {
    const body = await c.req.json<{
      project?: string;
      stage?: string;
      workflow?: string;
      ordered_slugs?: string[];
    }>();
    const project = body.project?.trim() ?? "";
    const stage = body.stage?.trim() ?? "";
    const workflow = body.workflow?.trim() ?? "";
    const ordered_slugs = body.ordered_slugs;
    if (!project || !stage || !workflow || !Array.isArray(ordered_slugs)) {
      return c.json(
        {
          message: "project, stage, workflow, and ordered_slugs are required",
          code: "VALIDATION",
        },
        400,
      );
    }
    const hidden = await denyUnlessProjectVisible(c, project);
    if (hidden) return hidden;
    const denied = await enforceProjectRole(
      deps.service,
      await principalFor(c, deps.service),
      project,
      requiredRoleForAction("write_tickets"),
    );
    if (denied) {
      return c.json({ message: denied, code: "FORBIDDEN" }, 403);
    }
    try {
      const changed = await deps.service.reorderTickets({
        project,
        stage,
        workflow,
        ordered_slugs,
      });
      const mapped = changed.map((t) => {
        const row = mapTicket(t);
        publishTicketEvent(ticketEventFromMapped("ticket.updated", row));
        return row;
      });
      audit(c, {
        action: "ticket.reorder",
        resourceType: "project",
        resourceId: project,
        meta: { stage, workflow, count: mapped.length },
      });
      return c.json({ tickets: mapped });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ message, code: "VALIDATION" }, 400);
    }
  });

  app.post(
    "/v1/tickets/:slug/transition",
    requireScope("tickets:write"),
    async (c) => {
      const body = await c.req.json<{
        to_stage: string;
        comment?: string;
        expected_stage?: string;
        expected_review_state?: string | null;
        tokens_estimate?: number;
        tokens_used?: number;
        resolution?: string;
      }>();
      if (!body?.to_stage) {
        return c.json(
          { message: "to_stage is required", code: "VALIDATION" },
          400,
        );
      }
      if (!body.comment?.trim()) {
        return c.json(
          {
            message:
              "comment is required on every transition (min ~40 chars; required Markdown headings come from the workflow JSON)",
            code: "VALIDATION",
          },
          400,
        );
      }
      const slug = param(c, "slug");
      const before = await deps.service.getTicket(slug);
      if (!before) {
        return c.json({ message: "Ticket not found", code: "NOT_FOUND" }, 404);
      }
      const hidden = await denyUnlessProjectVisible(
        c,
        before.ticket.fields.project,
        "Ticket not found",
      );
      if (hidden) return hidden;
      const denied = await enforceProjectRole(
        deps.service,
        await principalFor(c, deps.service),
        before.ticket.fields.project,
        requiredRoleForAction("write_tickets"),
      );
      if (denied) {
        return c.json({ message: denied, code: "FORBIDDEN" }, 403);
      }
      const fromStage = before.ticket.fields.stage;
      const actor = c.get("actor");
      const asHuman = isHumanProxyRequest(c);
      try {
        const ticket = await deps.service.transitionTicket(slug, body.to_stage, {
          comment: body.comment,
          author: actor.name,
          tokens_estimate: body.tokens_estimate,
          tokens_used: body.tokens_used,
          resolution: body.resolution,
          expected_stage: body.expected_stage,
          expected_review_state: body.expected_review_state,
          reviewStateProvided: Object.prototype.hasOwnProperty.call(
            body,
            "expected_review_state",
          ),
          asHuman,
        });
        publishTicketEvent(
          ticketEventFromMapped("ticket.transitioned", mapTicket(ticket), {
            from_stage: fromStage,
            to_stage: ticket.fields.stage,
          }),
        );
        if (typeof body.tokens_used === "number") {
          observeTokensUsed({
            project: ticket.fields.project,
            tokens: body.tokens_used,
          });
        }
        // Scenario A/B: notify humans when an agent enters a gated stage.
        if (!asHuman) {
          const human = resolveHumanIdentity(c);
          await notifyReviewRequested(deps.service, ticket, {
            excludeRecipient: human?.slug ?? null,
          });
        }
        audit(c, {
          action: asHuman ? "ticket.human_transition" : "ticket.transition",
          resourceType: "ticket",
          resourceId: ticket.slug,
          meta: {
            from_stage: fromStage,
            to_stage: body.to_stage,
            tokens_estimate: body.tokens_estimate ?? null,
            tokens_used: body.tokens_used ?? null,
            tokens_actual: ticket.fields.tokens_actual ?? null,
            resolution: ticket.fields.resolution ?? null,
            as_human: asHuman,
          },
        });
        return c.json({
          slug: ticket.slug,
          ticket_key: ticket.fields.ticket_key ?? null,
          stage: ticket.fields.stage,
          title: ticket.fields.title,
          from_stage: fromStage,
          tokens_estimate: ticket.fields.tokens_estimate ?? null,
          tokens_actual: ticket.fields.tokens_actual ?? null,
          resolution: ticket.fields.resolution ?? null,
        });
      } catch (error) {
        if (error instanceof StageConflictError) {
          return c.json(
            {
              message: error.message,
              code: error.code,
              expected_stage: error.expected_stage,
              current_stage: error.current_stage,
              expected_review_state: error.expected_review_state,
              review_state: error.review_state,
              to_stage: error.to_stage,
              stage_entered_at: error.stage_entered_at,
              recent_comments: error.recent_comments,
            },
            409,
          );
        }
        if (error instanceof HumanGateOpenError) {
          return c.json(
            {
              message: error.message,
              code: error.code,
              current_stage: error.current_stage,
              review_state: error.review_state,
              to_stage: error.to_stage,
              allowed_targets: error.allowed_targets,
            },
            409,
          );
        }
        if (error instanceof ExpectedStateRequiredError) {
          return c.json(
            { message: error.message, code: "VALIDATION" },
            400,
          );
        }
        throw error;
      }
    },
  );

  // Human review verdict: records the decision only. The agent still performs
  // the stage transition, gated on the verdict recorded here.
  app.post("/v1/tickets/:slug/review", requireScope("tickets:write"), async (c) => {
    if (!isHumanProxyRequest(c)) {
      return c.json(
        {
          message:
            "A review verdict can only be recorded by a signed-in human via the TraceAI UI (Goedkeuren/Afkeuren/Annuleren).",
          code: "HUMAN_ONLY",
        },
        403,
      );
    }
    const human = resolveHumanIdentity(c);
    const body = await c.req.json<{
      verdict?: string;
      comment?: string;
      reviewer?: string;
      apply_to_children?: boolean;
    }>();
    if (!body?.verdict) {
      return c.json(
        {
          message: `verdict is required (${TICKET_REVIEW_STATES.join(" | ")})`,
          code: "VALIDATION",
        },
        400,
      );
    }
    const verdict = body.verdict;
    const existing = await deps.service.getTicket(param(c, "slug"));
    if (!existing) {
      return c.json({ message: "Ticket not found", code: "NOT_FOUND" }, 404);
    }
    const hidden = await denyUnlessProjectVisible(
      c,
      existing.ticket.fields.project,
      "Ticket not found",
    );
    if (hidden) return hidden;
    const denied = await enforceProjectRole(
      deps.service,
      await principalFor(c, deps.service),
      existing.ticket.fields.project,
      requiredRoleForAction("review"),
    );
    if (denied) {
      return c.json({ message: denied, code: "FORBIDDEN" }, 403);
    }
    const actor = c.get("actor");
    const result = await deps.service.recordReviewVerdict(param(c, "slug"), {
      verdict: verdict,
      comment: body.comment,
      author: attributionName(
        human,
        body.reviewer?.trim() || actor.name,
      ),
      apply_to_children: body.apply_to_children === true,
    });
    const mapped = mapTicket(result.ticket);
    publishTicketEvent(ticketEventFromMapped("ticket.reviewed", mapped));
    getNotificationStore().markTicketReviewRead(result.ticket.slug);
    for (const child of result.cascaded) {
      publishTicketEvent(
        ticketEventFromMapped("ticket.reviewed", mapTicket(child)),
      );
      getNotificationStore().markTicketReviewRead(child.slug);
    }
    let reviewerAuthUserId: string | null = null;
    if (human?.mode === "personal" && human.slug) {
      try {
        const resolved = await resolveSelfServiceAuthUser(
          deps.service,
          deps.authStore,
          human,
        );
        if (resolved.ok) reviewerAuthUserId = resolved.user.id;
      } catch (error) {
        console.warn("[traceai] reviewer Agent APIs join failed", error);
      }
    }
    const liveCursorCloud =
      deps.cursorCloud !== undefined
        ? cursorCloud
        : (ticket: Ticket) =>
            cursorFollowUpForClaimer(deps.authStore, ticket, {
              fetchImpl: deps.cursorCloudFetch,
              fallbackUserId: reviewerAuthUserId,
              onSkip: (skipped, reason) => {
                const addComment = deps.service.addComment?.bind(deps.service);
                if (!addComment) return;
                void addComment({
                    ticket: skipped.slug,
                    body:
                      `Cloud wake-up skipped for ${skipped.slug} ` +
                      `(${skipped.fields.ticket_key ?? skipped.slug}): ${reason}. ` +
                      `Save a Cursor key on Agent APIs (same personal login as the claim or this review). ` +
                      `Verdict and claim are unchanged.`,
                    author: "traceai",
                  }).catch((error) => {
                    console.warn(
                      "[traceai] cursor cloud nudge skip comment failed",
                      error,
                    );
                  });
              },
            });
    scheduleClaimedCloudNudges(
      [result.ticket, ...result.cascaded],
      verdict,
      liveCursorCloud,
      deps.scheduleWakeup,
      (ticket, nudgeResult) => {
        if (!nudgeQueue) return;
        try {
          enqueueBusyCloudNudgeForVerdict(
            nudgeQueue,
            ticket,
            verdict,
            nudgeResult,
            now(),
            reviewerAuthUserId,
          );
        } catch (error) {
          console.warn("[traceai] cursor cloud nudge enqueue failed", error);
        }
      },
    );
    audit(c, {
      action: "ticket.review_verdict",
      resourceType: "ticket",
      resourceId: result.ticket.slug,
      meta: {
        stage: result.ticket.fields.stage,
        verdict: result.ticket.fields.review_state ?? null,
        review_by: result.ticket.fields.review_by ?? null,
        apply_to_children: body.apply_to_children === true,
        cascaded: result.cascaded.map((t) => t.slug),
      },
    });
    return c.json({
      ...mapped,
      cascaded: result.cascaded.map(mapTicket),
    });
  });

  app.post("/v1/comments", requireScope("comments:write"), async (c) => {
    const actor = c.get("actor");
    const body = await c.req.json<{ ticket: string; body: string }>();
    if (!body?.ticket || !body?.body?.trim()) {
      return c.json(
        { message: "ticket and body are required", code: "VALIDATION" },
        400,
      );
    }
    // Resolve the ticket before writing: its project decides both checks, and a
    // comment on a ticket you cannot see must not be possible (TRA-82).
    const target = await deps.service.getTicket(body.ticket);
    if (!target) {
      return c.json({ message: "Ticket not found", code: "NOT_FOUND" }, 404);
    }
    const hidden = await denyUnlessProjectVisible(
      c,
      target.ticket.fields.project,
      "Ticket not found",
    );
    if (hidden) return hidden;
    const denied = await enforceProjectRole(
      deps.service,
      await principalFor(c, deps.service),
      target.ticket.fields.project,
      // No separate "comment" action: extending the role model is out of scope
      // for TRA-82, and a comment is an editor-level write like a ticket edit.
      requiredRoleForAction("write_tickets"),
    );
    if (denied) {
      return c.json({ message: denied, code: "FORBIDDEN" }, 403);
    }
    const comment = await deps.service.addComment({
      ticket: body.ticket,
      body: body.body,
      author: actor.name,
    });
    const parent = await deps.service.getTicket(body.ticket);
    if (parent) {
      publishTicketEvent(
        ticketEventFromMapped("ticket.commented", mapTicket(parent.ticket)),
      );
    }
    audit(c, {
      action: "comment.create",
      resourceType: "comment",
      resourceId: comment.slug,
      meta: { ticket: body.ticket },
    });
    return c.json(
      {
        slug: comment.slug,
        ticket: comment.fields.ticket,
        author: comment.fields.author ?? null,
        body: comment.fields.body,
      },
      201,
    );
  });

  app.get("/v1/wiki-pages", requireScope("wiki:read"), async (c) => {
    const project = c.req.query("project");
    if (!project) {
      return c.json(
        { message: "project query param is required", code: "VALIDATION" },
        400,
      );
    }
    const hidden = await denyUnlessProjectVisible(c, project);
    if (hidden) return hidden;
    const includeBody = c.req.query("include_body") === "true";
    const parentQuery = c.req.query("parent");
    const page = await deps.service.listWikiPages({
      project,
      parent: parentQuery == null ? undefined : parentQuery,
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
      offset: c.req.query("offset") ? Number(c.req.query("offset")) : undefined,
    });
    return c.json({
      items: page.items.map((p) => mapWikiPage(p, { includeBody })),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    });
  });

  app.get("/v1/wiki-pages/:slug", requireScope("wiki:read"), async (c) => {
    const page = await deps.service.getWikiPage(param(c, "slug"));
    if (!page) {
      return c.json({ message: "Wiki page not found", code: "NOT_FOUND" }, 404);
    }
    const hidden = await denyUnlessProjectVisible(
      c,
      relationSlug(page.fields.project),
      "Wiki page not found",
    );
    if (hidden) return hidden;
    return c.json(mapWikiPage(page));
  });

  app.post("/v1/wiki-pages", requireScope("wiki:write"), async (c) => {
    const actor = c.get("actor");
    const body = await c.req.json<{
      project: string;
      title: string;
      body?: string;
      parent?: string | null;
      sort_order?: number;
      slug?: string;
    }>();
    if (!body?.project || !body?.title?.trim()) {
      return c.json(
        { message: "project and title are required", code: "VALIDATION" },
        400,
      );
    }
    const hiddenProject = await denyUnlessProjectVisible(c, body.project);
    if (hiddenProject) return hiddenProject;
    const deniedRole = await enforceProjectRole(
      deps.service,
      await principalFor(c, deps.service),
      body.project,
      requiredRoleForAction("write_wiki"),
    );
    if (deniedRole) {
      return c.json({ message: deniedRole, code: "FORBIDDEN" }, 403);
    }
    const page = await deps.service.createWikiPage({
      ...body,
      updated_by: actor.name,
    });
    observeWikiWrite({ project: page.fields.project, op: "create" });
    audit(c, {
      action: "wiki.create",
      resourceType: "wiki_page",
      resourceId: page.slug,
      meta: { project: page.fields.project },
    });
    return c.json(mapWikiPage(page), 201);
  });

  app.patch("/v1/wiki-pages/:slug", requireScope("wiki:write"), async (c) => {
    const actor = c.get("actor");
    const body = await c.req.json<{
      title?: string;
      body?: string;
      edits?: unknown;
      parent?: string | null;
      sort_order?: number;
    }>();

    let edits: FieldEdit[] | undefined;
    if (body?.edits !== undefined) {
      const parsed = parseFieldEdits(body.edits);
      if ("error" in parsed) {
        return c.json({ message: parsed.error, code: "VALIDATION" }, 400);
      }
      edits = parsed.edits;
      if (body.body != null) {
        return c.json(
          {
            message: "Pass either body (full replace) or edits (patch), not both.",
            code: "VALIDATION",
          },
          400,
        );
      }
    }

    const existing = await deps.service.getWikiPage(param(c, "slug"));
    if (!existing) {
      return c.json({ message: "Wiki page not found", code: "NOT_FOUND" }, 404);
    }
    const pageProject = relationSlug(existing.fields.project);
    const hidden = await denyUnlessProjectVisible(
      c,
      pageProject,
      "Wiki page not found",
    );
    if (hidden) return hidden;
    const denied = await enforceProjectRole(
      deps.service,
      await principalFor(c, deps.service),
      pageProject ?? "",
      requiredRoleForAction("write_wiki"),
    );
    if (denied) {
      return c.json({ message: denied, code: "FORBIDDEN" }, 403);
    }

    let result: Awaited<ReturnType<TraceService["updateWikiPage"]>>;
    try {
      result = await deps.service.updateWikiPage(param(c, "slug"), {
        ...body,
        edits,
        updated_by: actor.name,
      });
    } catch (error) {
      // Aurora separates "your anchor is stale" (409) from "your request is
      // wrong" (400). Both are expected outcomes and must reach the agent as
      // themselves: a 409 means re-read and retry, a 400 means retrying is
      // pointless. Collapsing either into a 500 sends agents the wrong way.
      if (error instanceof AuroraApiError && isPassThroughStatus(error.status)) {
        return c.json(auroraErrorBody(error), error.status as 400 | 409);
      }
      throw error;
    }

    const page = result.page;
    observeWikiWrite({ project: page.fields.project, op: "update" });
    audit(c, {
      action: "wiki.update",
      resourceType: "wiki_page",
      resourceId: page.slug,
      meta: { project: page.fields.project },
    });
    return c.json({
      ...mapWikiPage(page),
      ...(result.applied_edits != null
        ? { applied_edits: result.applied_edits }
        : {}),
    });
  });

  app.get("/v1/workflows", requireScope("workflows:read"), async (c) => {
    const project = c.req.query("project") ?? undefined;
    // Naming a project is the same question as asking for it directly, so it
    // gets the same 404. Without a filter this is "what may I see", so it
    // filters silently instead of refusing.
    const hidden = await denyUnlessProjectVisible(c, project);
    if (hidden) return hidden;
    const workflows = await deps.service.listWorkflows(project);
    const guard = c.get("projectGuard");
    const visible = guard
      ? visibleForAccess(await guard.access(), workflows, (w) =>
          relationSlug(w.fields.project),
        )
      : workflows;
    return c.json(visible.map(mapWorkflow));
  });

  app.get("/v1/workflows/:slug", requireScope("workflows:read"), async (c) => {
    const result = await deps.service.getWorkflow(param(c, "slug"));
    if (!result) {
      return c.json({ message: "Workflow not found", code: "NOT_FOUND" }, 404);
    }
    // A workflow without a project (`traceai-default`) belongs to nobody and
    // stays readable; denyUnlessProjectVisible treats an empty slug as "no
    // access question", so that falls out of the helper rather than a branch.
    const hidden = await denyUnlessProjectVisible(
      c,
      relationSlug(result.workflow.fields.project),
      "Workflow not found",
    );
    if (hidden) return hidden;
    return c.json({
      ...mapWorkflow(result.workflow),
      stages: result.stages,
      agent_policy: result.workflow_document.agent_policy,
      workflow_document: result.workflow_document,
    });
  });

  app.post("/v1/workflows", requireScope("workflows:write"), async (c) => {
    const body = await c.req.json<{
      name: string;
      project: string;
      slug?: string;
      stages?: Array<{ key: string; name: string; transitions: string[] }>;
    }>();
    if (!body?.name || !body?.project) {
      return c.json(
        { message: "name and project are required", code: "VALIDATION" },
        400,
      );
    }
    const hidden = await denyUnlessProjectVisible(c, body.project);
    if (hidden) return hidden;
    const denied = await enforceProjectRole(
      deps.service,
      await principalFor(c, deps.service),
      body.project,
      requiredRoleForAction("write_workflow"),
    );
    if (denied) {
      return c.json({ message: denied, code: "FORBIDDEN" }, 403);
    }
    const workflow = await deps.service.createWorkflow(body);
    audit(c, {
      action: "workflow.create",
      resourceType: "workflow",
      resourceId: workflow.slug,
    });
    return c.json(mapWorkflow(workflow), 201);
  });

  app.post(
    "/v1/projects/:slug/workflows/clone",
    requireScope("workflows:write"),
    async (c) => {
      const principal = await principalFor(c, deps.service);
      if (!principal.isPlatformAdmin) {
        return c.json(
          { message: "Platform admin required", code: "FORBIDDEN" },
          403,
        );
      }
      let body: { source?: string };
      try {
        body = (await c.req.json()) as { source?: string };
      } catch {
        return c.json(
          { message: "Invalid JSON body", code: "VALIDATION" },
          400,
        );
      }
      if (!body?.source?.trim()) {
        return c.json(
          { message: "source is required", code: "VALIDATION" },
          400,
        );
      }
      const workflow = await deps.service.cloneWorkflow({
        source: body.source.trim(),
        project: param(c, "slug"),
      });
      audit(c, {
        action: "workflow.clone",
        resourceType: "workflow",
        resourceId: workflow.slug,
        meta: { source: body.source.trim(), project: param(c, "slug") },
      });
      return c.json(mapWorkflow(workflow), 201);
    },
  );

  app.patch(
    "/v1/workflows/:slug",
    requireScope("workflows:write"),
    async (c) => {
      const body = await c.req.json<{
        name?: string;
        stages?: Array<{
          key: string;
          name: string;
          transitions: string[];
          agent?: Record<string, unknown>;
        }>;
        document?: {
          version?: number;
          agent_policy?: Record<string, unknown>;
          stages?: Array<{
            key: string;
            name: string;
            transitions: string[];
            agent?: Record<string, unknown>;
          }>;
        };
        agent_policy?: Record<string, unknown>;
      }>();
      const denied = await denyWorkflowAccess(c, "write_workflow");
      if (denied) return denied;
      try {
        const workflow = await deps.service.updateWorkflow(param(c, "slug"), {
          name: body.name,
          stages: body.stages as never,
          document: body.document as never,
          agent_policy: body.agent_policy as never,
        });
        const doc = parseWorkflowDocument(workflow.fields.stages_json);
        audit(c, {
          action: "workflow.update",
          resourceType: "workflow",
          resourceId: workflow.slug,
        });
        return c.json({
          ...mapWorkflow(workflow),
          stages: doc.stages,
          agent_policy: doc.agent_policy,
          workflow_document: doc,
        });
      } catch (error) {
        if (error instanceof WorkflowValidationError) {
          return c.json(
            {
              message: error.message,
              code: "VALIDATION",
              issues: error.issues,
            },
            400,
          );
        }
        throw error;
      }
    },
  );

  app.post(
    "/v1/workflows/:slug/draft",
    requireScope("workflows:write"),
    async (c) => {
      const guarded = await denyWorkflowAccess(c, "write_workflow");
      if (guarded) return guarded;
      const body = await c.req.json<{
        canvas?: Record<string, unknown>;
        pending?: Record<string, unknown>;
        name?: string;
        saved_by?: string;
      }>();
      const actor = c.get("actor");
      try {
        const result = await deps.service.saveWorkflowDraft(param(c, "slug"), {
          canvas: body.canvas as never,
          pending: body.pending as never,
          name: body.name,
          saved_by: body.saved_by ?? actor.name,
        });
        audit(c, {
          action: "workflow.draft_save",
          resourceType: "workflow",
          resourceId: result.workflow.slug,
        });
        return c.json({
          ...mapWorkflow(result.workflow),
          workflow_document: result.workflow_document,
          aurora_version_id: result.aurora_version_id,
          stages: result.workflow_document.stages,
          agent_policy: result.workflow_document.agent_policy,
        });
      } catch (error) {
        if (error instanceof WorkflowValidationError) {
          return c.json(
            {
              message: error.message,
              code: "VALIDATION",
              issues: error.issues,
            },
            400,
          );
        }
        throw error;
      }
    },
  );

  app.get(
    "/v1/workflows/:slug/activation-preview",
    requireScope("workflows:read"),
    async (c) => {
      const guarded = await denyWorkflowAccess(c, "read");
      if (guarded) return guarded;
      try {
        const preview = await deps.service.previewWorkflowActivation(
          param(c, "slug"),
        );
        return c.json(preview);
      } catch (error) {
        return c.json(
          {
            message: error instanceof Error ? error.message : String(error),
            code: "NOT_FOUND",
          },
          404,
        );
      }
    },
  );

  app.post(
    "/v1/workflows/:slug/activate",
    requireScope("workflows:write"),
    async (c) => {
      const body = await c.req.json<{
        migration?: Record<string, string>;
        activated_by?: string;
      }>();
      const guarded = await denyWorkflowAccess(c, "write_workflow");
      if (guarded) return guarded;
      const actor = c.get("actor");
      try {
        const result = await deps.service.activateWorkflow(param(c, "slug"), {
          migration: body.migration,
          activated_by: body.activated_by ?? actor.name,
        });
        audit(c, {
          action: "workflow.activate",
          resourceType: "workflow",
          resourceId: result.workflow.slug,
          meta: { migrated_tickets: result.migrated_tickets },
        });
        return c.json({
          ...mapWorkflow(result.workflow),
          workflow_document: result.workflow_document,
          migrated_tickets: result.migrated_tickets,
          aurora_version_id: result.aurora_version_id,
          stages: result.workflow_document.stages,
          agent_policy: result.workflow_document.agent_policy,
        });
      } catch (error) {
        if (error instanceof WorkflowValidationError) {
          return c.json(
            {
              message: error.message,
              code: "VALIDATION",
              issues: error.issues,
            },
            400,
          );
        }
        throw error;
      }
    },
  );

  app.get(
    "/v1/workflows/:slug/versions",
    requireScope("workflows:read"),
    async (c) => {
      const guarded = await denyWorkflowAccess(c, "read");
      if (guarded) return guarded;
      const versions = await deps.service.listWorkflowVersions(param(c, "slug"));
      return c.json(
        versions.map((v) => ({
          id: v.id,
          label: v.label,
          source: v.source,
          createdAt: v.createdAt,
        })),
      );
    },
  );

  app.post(
    "/v1/workflows/:slug/versions/:versionId/restore",
    requireScope("workflows:write"),
    async (c) => {
      const guarded = await denyWorkflowAccess(c, "write_workflow");
      if (guarded) return guarded;
      const result = await deps.service.restoreWorkflowVersion(
        param(c, "slug"),
        param(c, "versionId"),
      );
      audit(c, {
        action: "workflow.restore_version",
        resourceType: "workflow",
        resourceId: result.workflow.slug,
        meta: { versionId: param(c, "versionId") },
      });
      return c.json({
        ...mapWorkflow(result.workflow),
        workflow_document: result.workflow_document,
        restored_from: {
          id: result.restored_from.id,
          label: result.restored_from.label,
          createdAt: result.restored_from.createdAt,
        },
      });
    },
  );

  app.post(
    "/v1/workflows/:slug/templates/apply",
    requireScope("workflows:write"),
    async (c) => {
      const body = await c.req.json<{
        template_slug: string;
        title?: string;
        description?: string;
        priority?: string;
        mode?: "fill_empty" | "confirm_overwrite" | "merge_headings";
        confirmed?: boolean;
      }>();
      const guarded = await denyWorkflowAccess(c, "write_workflow");
      if (guarded) return guarded;
      if (!body?.template_slug?.trim()) {
        return c.json(
          { message: "template_slug is required", code: "VALIDATION" },
          400,
        );
      }
      try {
        const templates = await deps.service.getWorkflowTemplates(
          param(c, "slug"),
        );
        const template = templates.find((t) => t.slug === body.template_slug);
        if (!template) {
          return c.json(
            { message: "Template not found", code: "NOT_FOUND" },
            404,
          );
        }
        const applied = deps.service.applyWorkflowTicketTemplate(
          template,
          {
            title: body.title,
            description: body.description,
            priority: body.priority,
          },
          {
            mode: body.mode ?? "fill_empty",
            confirmed: body.confirmed,
          },
        );
        return c.json(applied);
      } catch (error) {
        return c.json(
          {
            message: error instanceof Error ? error.message : String(error),
            code: "VALIDATION",
          },
          400,
        );
      }
    },
  );

  // TraceAI personal users (Aurora-backed; managed via TraceAI UI)
  app.get("/v1/traceai-users", requireScope("admin"), async (c) => {
    const users = await deps.service.listTraceaiUsers();
    return c.json(users.map(mapTraceaiUser));
  });

  app.post("/v1/traceai-users", requireScope("admin"), async (c) => {
    const human = resolveHumanIdentity(c);
    if (
      human &&
      !human.is_platform_admin &&
      human.mode !== "legacy"
    ) {
      return c.json(
        {
          message: "Only platform admins can create TraceAI users",
          code: "FORBIDDEN",
        },
        403,
      );
    }
    const body = await c.req.json<{
      username?: string;
      password?: string;
      display_name?: string;
      email?: string;
      is_platform_admin?: boolean;
    }>();
    if (!body?.username?.trim() || !body?.password) {
      return c.json(
        { message: "username and password are required", code: "VALIDATION" },
        400,
      );
    }
    try {
      const user = await deps.service.createTraceaiUser({
        username: body.username,
        password: body.password,
        display_name: body.display_name?.trim() || body.username,
        email: body.email,
        is_platform_admin: body.is_platform_admin === true,
      });
      audit(c, {
        action: "traceai_user.create",
        resourceType: "traceai_user",
        resourceId: user.slug,
      });
      return c.json(mapTraceaiUser(user), 201);
    } catch (error) {
      return c.json(
        {
          message: error instanceof Error ? error.message : "Create failed",
          code: "VALIDATION",
        },
        400,
      );
    }
  });

  app.patch("/v1/traceai-users/:slug", requireScope("admin"), async (c) => {
    const human = resolveHumanIdentity(c);
    if (
      human &&
      !human.is_platform_admin &&
      human.mode !== "legacy"
    ) {
      return c.json(
        {
          message: "Only platform admins can update TraceAI users",
          code: "FORBIDDEN",
        },
        403,
      );
    }
    const body = await c.req.json<{
      display_name?: string;
      email?: string | null;
      status?: string;
      is_platform_admin?: boolean;
      password?: string;
    }>();
    try {
      const user = await deps.service.updateTraceaiUser(param(c, "slug"), body);
      audit(c, {
        action: "traceai_user.update",
        resourceType: "traceai_user",
        resourceId: user.slug,
      });
      return c.json(mapTraceaiUser(user));
    } catch (error) {
      return c.json(
        {
          message: error instanceof Error ? error.message : "Update failed",
          code: "VALIDATION",
        },
        400,
      );
    }
  });

  app.get(
    "/v1/projects/:slug/members",
    requireScope("projects:read"),
    async (c) => {
      const project = param(c, "slug");
      const denied = await enforceProjectRole(
        deps.service,
        await principalFor(c, deps.service),
        project,
        requiredRoleForAction("read"),
      );
      if (denied) {
        return c.json({ message: denied, code: "FORBIDDEN" }, 403);
      }
      const members = await deps.service.listProjectMemberships(project);
      return c.json(members.map(mapMembership));
    },
  );

  app.post(
    "/v1/projects/:slug/members",
    requireScope("projects:write"),
    async (c) => {
      const project = param(c, "slug");
      // The `admin`-scope escape now lives inside enforceProjectRole (TRA-82),
      // so a denial here is final. The second check that used to sit here let
      // every token past the role check and is exactly what this ticket closes.
      const denied = await enforceProjectRole(
        deps.service,
        await principalFor(c, deps.service),
        project,
        requiredRoleForAction("manage_members"),
      );
      if (denied) {
        return c.json({ message: denied, code: "FORBIDDEN" }, 403);
      }
      const body = await c.req.json<{ user?: string; role?: string }>();
      if (!body?.user?.trim() || !isProjectRole(body.role)) {
        return c.json(
          {
            message: "user and role (admin|editor|viewer) are required",
            code: "VALIDATION",
          },
          400,
        );
      }
      try {
        const membership = await deps.service.setProjectMembership({
          project,
          user: body.user,
          role: body.role,
        });
        audit(c, {
          action: "project_membership.set",
          resourceType: "project_membership",
          resourceId: membership.slug,
          meta: { project, user: body.user, role: body.role },
        });
        return c.json(mapMembership(membership), 201);
      } catch (error) {
        return c.json(
          {
            message: error instanceof Error ? error.message : "Set failed",
            code: "VALIDATION",
          },
          400,
        );
      }
    },
  );

  app.delete(
    "/v1/projects/:slug/members/:user",
    requireScope("projects:write"),
    async (c) => {
      const project = param(c, "slug");
      const user = param(c, "user");
      const denied = await enforceProjectRole(
        deps.service,
        await principalFor(c, deps.service),
        project,
        requiredRoleForAction("manage_members"),
      );
      if (denied) {
        return c.json({ message: denied, code: "FORBIDDEN" }, 403);
      }
      const removed = await deps.service.removeProjectMembership(project, user);
      if (!removed) {
        return c.json({ message: "Membership not found", code: "NOT_FOUND" }, 404);
      }
      audit(c, {
        action: "project_membership.remove",
        resourceType: "project_membership",
        resourceId: membershipSlug(project, user),
      });
      return c.json({ ok: true as const });
    },
  );

  app.get(
    "/v1/inbox/reviews",
    requireScope("tickets:read"),
    async (c) => {
      const human = resolveHumanIdentity(c);
      if (!human) {
        return c.json(
          {
            message: "Review inbox requires a signed-in human identity",
            code: "HUMAN_ONLY",
          },
          403,
        );
      }
      const projects = await accessibleProjectSlugs(
        deps.service,
        await resolvePrincipal({
          service: deps.service,
          human,
          actor: c.get("actor"),
        }),
      );
      const items = await deps.service.listReviewInbox(projects);
      return c.json({
        awaiting_verdict: items
          .filter((i) => i.awaiting === "verdict")
          .map((i) => ({
            ...mapTicket(i.ticket),
            stage_key: i.stage_key,
            stage_name: i.stage_name,
            awaiting: i.awaiting,
          })),
        awaiting_agent: items
          .filter((i) => i.awaiting === "agent")
          .map((i) => ({
            ...mapTicket(i.ticket),
            stage_key: i.stage_key,
            stage_name: i.stage_name,
            awaiting: i.awaiting,
          })),
      });
    },
  );

  app.get(
    "/v1/notifications",
    requireScope("tickets:read"),
    async (c) => {
      const human = resolveHumanIdentity(c);
      if (!human?.slug && human?.mode !== "legacy") {
        return c.json(
          { message: "Notifications require a personal user", code: "HUMAN_ONLY" },
          403,
        );
      }
      const recipient =
        human!.slug ||
        (human!.mode === "legacy" ? human!.user : null);
      if (!recipient) {
        return c.json(
          { message: "Notifications require a personal user", code: "HUMAN_ONLY" },
          403,
        );
      }
      const unreadOnly = c.req.query("unread") === "1";
      const store = getNotificationStore();
      return c.json({
        unread_count: store.unreadCount(recipient),
        items: store.listForRecipient(recipient, { unreadOnly }),
      });
    },
  );

  app.post(
    "/v1/notifications/mark-read",
    requireScope("tickets:write"),
    async (c) => {
      const human = resolveHumanIdentity(c);
      const recipient =
        human?.slug ||
        (human?.mode === "legacy" ? human.user : null);
      if (!recipient) {
        return c.json(
          { message: "Notifications require a personal user", code: "HUMAN_ONLY" },
          403,
        );
      }
      const body = (await c.req
        .json<{ id?: number; all?: boolean }>()
        .catch(() => ({ id: undefined, all: undefined }))) as {
        id?: number;
        all?: boolean;
      };
      const store = getNotificationStore();
      if (body.all) {
        return c.json({ ok: true as const, marked: store.markAllRead(recipient) });
      }
      if (typeof body.id !== "number") {
        return c.json(
          { message: "id or all=true required", code: "VALIDATION" },
          400,
        );
      }
      const ok = store.markRead(recipient, body.id);
      if (!ok) {
        return c.json({ message: "Notification not found", code: "NOT_FOUND" }, 404);
      }
      return c.json({ ok: true as const, marked: 1 });
    },
  );

  // Admin: users & tokens
  app.get("/v1/admin/users", requireScope("admin"), async (c) => {
    return c.json(deps.authStore.listUsers());
  });

  app.post("/v1/admin/users", requireScope("admin"), async (c) => {
    const body = await c.req.json<{ email: string; name: string }>();
    if (!body?.email || !body?.name) {
      return c.json(
        { message: "email and name are required", code: "VALIDATION" },
        400,
      );
    }
    const user = deps.authStore.createUser(body);
    audit(c, {
      action: "user.create",
      resourceType: "user",
      resourceId: user.id,
    });
    return c.json(user, 201);
  });

  app.get("/v1/admin/tokens", requireScope("admin"), async (c) => {
    const userId = c.req.query("userId") ?? undefined;
    return c.json(deps.authStore.listTokens(userId));
  });

  app.post("/v1/admin/tokens", requireScope("admin"), async (c) => {
    const body = await c.req.json<{
      userId: string;
      name: string;
      scopes?: string[];
      expiresAt?: string | null;
    }>();
    if (!body?.userId || !body?.name) {
      return c.json(
        { message: "userId and name are required", code: "VALIDATION" },
        400,
      );
    }
    const token = deps.authStore.createToken({
      userId: body.userId,
      name: body.name,
      scopes: body.scopes as never,
      expiresAt: body.expiresAt,
    });
    audit(c, {
      action: "token.create",
      resourceType: "token",
      resourceId: token.id,
      meta: { userId: body.userId },
    });
    return c.json(token, 201);
  });

  app.post(
    "/v1/admin/tokens/:id/revoke",
    requireScope("admin"),
    async (c) => {
      const token = deps.authStore.revokeToken(param(c, "id"));
      if (!token) {
        return c.json({ message: "Token not found", code: "NOT_FOUND" }, 404);
      }
      audit(c, {
        action: "token.revoke",
        resourceType: "token",
        resourceId: token.id,
      });
      return c.json(token);
    },
  );

  app.get("/v1/admin/audit", requireScope("admin"), async (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json(deps.authStore.listAudit(limit));
  });

  app.onError((err, c) => {
    if (err instanceof StageConflictError) {
      return c.json(
        {
          message: err.message,
          code: err.code,
          expected_stage: err.expected_stage,
          current_stage: err.current_stage,
          expected_review_state: err.expected_review_state,
          review_state: err.review_state,
          to_stage: err.to_stage,
          stage_entered_at: err.stage_entered_at,
          recent_comments: err.recent_comments,
        },
        409,
      );
    }
    if (err instanceof HumanGateOpenError) {
      return c.json(
        {
          message: err.message,
          code: err.code,
          current_stage: err.current_stage,
          review_state: err.review_state,
          to_stage: err.to_stage,
          allowed_targets: err.allowed_targets,
        },
        409,
      );
    }
    if (err instanceof ExpectedStateRequiredError) {
      return c.json({ message: err.message, code: err.code }, 400);
    }
    if (err instanceof WorkflowValidationError) {
      return c.json(
        { message: err.message, code: "VALIDATION", issues: err.issues },
        400,
      );
    }
    if (err instanceof TraceError) {
      const body: Record<string, unknown> = {
        message: err.message,
        code: err.code,
      };
      if (err instanceof ValidationError && err.issues !== undefined) {
        body.issues = err.issues;
      }
      return c.json(body, err.status as 400 | 403 | 404);
    }
    if (err instanceof AuroraNetworkError) {
      return c.json({ message: err.message, code: "BAD_GATEWAY" }, 502);
    }
    if (err instanceof AuroraApiError) {
      if (isPassThroughStatus(err.status)) {
        return c.json(auroraErrorBody(err), err.status);
      }
      return c.json({ message: err.message, code: "BAD_GATEWAY" }, 502);
    }
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ message, code: "INTERNAL" }, 500);
  });

  return app;
}
