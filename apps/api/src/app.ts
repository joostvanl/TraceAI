import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { timingSafeEqual } from "node:crypto";
import type { AuthStore } from "@traceai/auth";
import { hasScope } from "@traceai/auth";
import type { TraceService } from "@traceai/core";
import {
  computeTokenRollup,
  isProjectRole,
  membershipSlug,
  parseWorkflowDocument,
  requiredRoleForAction,
  TICKET_REVIEW_STATES,
  WorkflowValidationError,
  wikiLogicalSlug,
  type ProjectRole,
  type Ticket,
} from "@traceai/core";
import {
  getEventsAfter,
  latestEventId,
  publishTicketEvent,
  subscribeTicketEvents,
  ticketEventFromMapped,
} from "./events.js";
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
import { getNotificationStore } from "./notifications.js";
import {
  resolveSelfServiceAuthUser,
  sanitizeSelfServiceScopes,
} from "./self-service-tokens.js";

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

async function enforceProjectRole(
  service: TraceService,
  identity: HumanIdentity | null,
  projectSlug: string,
  required: ProjectRole,
): Promise<string | null> {
  if (!identity) return null; // agent/token path: scopes already checked
  try {
    await service.assertProjectRole({
      projectSlug,
      userSlug: identity.slug,
      isPlatformAdmin: identity.is_platform_admin || identity.mode === "legacy",
      required,
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Forbidden";
  }
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

async function projectsForHuman(
  service: TraceService,
  identity: HumanIdentity,
): Promise<string[]> {
  if (identity.is_platform_admin || identity.mode === "legacy") {
    return (await service.listProjects()).map((p) => p.slug);
  }
  if (!identity.slug) return [];
  const memberships = await service.listProjectMemberships();
  return [
    ...new Set(
      memberships
        .filter((m) => m.fields.user === identity.slug)
        .map((m) => m.fields.project),
    ),
  ];
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
  if (!value) throw new Error(`Missing path param: ${key}`);
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
  p: Awaited<ReturnType<TraceService["listWikiPages"]>>[number],
) {
  return {
    slug: p.slug,
    title: p.fields.title,
    body: p.fields.body ?? "",
    project: p.fields.project,
    parent: p.fields.parent ?? null,
    sort_order: p.fields.sort_order ?? null,
    updated_by: p.fields.updated_by ?? null,
    updatedAt: p.updatedAt,
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

export function createApp(deps: {
  authStore: AuthStore;
  service: TraceService;
}) {
  const app = new Hono<{ Variables: AppVariables }>();
  const auth = createAuthMiddleware(deps.authStore);

  app.use(
    "*",
    cors({
      origin: corsOrigins(),
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
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

  app.get("/health", (c) => c.json({ status: "ok", service: "traceai-api" }));

  // Hosted MCP (Streamable HTTP) — Cursor remote config needs only URL + Bearer.
  // Mounted outside `/v1/*` so auth errors stay MCP/HTTP-native; still requires trc_….
  mountTraceAiMcp(app, deps.authStore);

  // Public SSE stream for read-only live boards (no bearer token).
  // Supports resume via `Last-Event-ID` header or `?after=<event_id>`: on
  // (re)connect the client replays every event it missed from the durable
  // store, then follows live events. Each message carries a stable `id:` so
  // the browser's EventSource resumes automatically after a drop.
  app.get("/events", (c) => {
    const projectFilter = c.req.query("project") ?? undefined;
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

  app.get("/v1/projects", requireScope("projects:read"), async (c) => {
    const projects = await deps.service.listProjects();
    return c.json(projects.map(mapProject));
  });

  app.get("/v1/me/projects", requireScope("projects:read"), async (c) => {
    const human = resolveHumanIdentity(c);
    if (!human) {
      return c.json(
        { message: "Human identity required", code: "UNAUTHORIZED" },
        401,
      );
    }
    const allowed = new Set(await projectsForHuman(deps.service, human));
    const projects = (await deps.service.listProjects()).filter((p) =>
      allowed.has(p.slug),
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
    const ownerUser =
      body.owner_user?.trim() ||
      (human?.slug && human.mode === "personal" ? human.slug : undefined);
    try {
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes("not found") ? 404 : 400;
      return c.json({ message, code: "VALIDATION" }, status);
    }
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
      const limit = Number(c.req.query("limit") ?? 25);
      const offset = Number(c.req.query("offset") ?? 0);
      try {
        const page = await deps.service.searchProject({
          project: slug,
          includeWiki: includeWiki && type !== "ticket",
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/not found/i.test(message)) {
          return c.json({ message, code: "NOT_FOUND" }, 404);
        }
        throw error;
      }
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
      try {
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/not found/i.test(message)) {
          return c.json({ message, code: "NOT_FOUND" }, 404);
        }
        throw error;
      }
    },
  );

  app.get(
    "/v1/projects/:slug/insights",
    requireScope("tickets:read"),
    async (c) => {
      const slug = param(c, "slug");
      try {
        const insights = await deps.service.getProjectInsights(slug);
        return c.json({ project: slug, ...insights });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/not found/i.test(message)) {
          return c.json({ message, code: "NOT_FOUND" }, 404);
        }
        throw error;
      }
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
    const stage = c.req.query("stage") ?? undefined;
    const parentRaw = c.req.query("parent");
    const parent =
      parentRaw === undefined
        ? undefined
        : parentRaw === "" || parentRaw === "null"
          ? null
          : parentRaw;
    // Load the full project set so roll-ups include descendants even when
    // the response is filtered by stage/parent.
    const projectTickets = await deps.service.listTickets({ project });
    const tickets = projectTickets
      .filter((t) => (stage ? t.fields.stage === stage : true))
      .filter((t) => {
        if (parent === undefined) return true;
        const value = t.fields.parent || null;
        if (parent === null) return value == null || value === "";
        return value === parent;
      });
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
        };
      }),
    );
  });

  app.get("/v1/tickets/:slug", requireScope("tickets:read"), async (c) => {
    const result = await deps.service.getTicket(param(c, "slug"));
    if (!result) {
      return c.json({ message: "Ticket not found", code: "NOT_FOUND" }, 404);
    }
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
    const denied = await enforceProjectRole(
      deps.service,
      human,
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
    const mapped = mapTicket(ticket);
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
    }>();
    const ticket = await deps.service.updateTicket(param(c, "slug"), body);
    const mapped = mapTicket(ticket);
    publishTicketEvent(ticketEventFromMapped("ticket.updated", mapped));
    audit(c, {
      action: "ticket.update",
      resourceType: "ticket",
      resourceId: ticket.slug,
    });
    return c.json(mapped);
  });

  app.post("/v1/tickets/reorder", requireScope("tickets:write"), async (c) => {
    const body = await c.req.json<{
      project?: string;
      stage?: string;
      ordered_slugs?: string[];
    }>();
    const project = body.project?.trim() ?? "";
    const stage = body.stage?.trim() ?? "";
    const ordered_slugs = body.ordered_slugs;
    if (!project || !stage || !Array.isArray(ordered_slugs)) {
      return c.json(
        {
          message: "project, stage, and ordered_slugs are required",
          code: "VALIDATION",
        },
        400,
      );
    }
    try {
      const changed = await deps.service.reorderTickets({
        project,
        stage,
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
        meta: { stage, count: mapped.length },
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
              "comment is required on every transition (## Vorige stap + ## Deze stap; entering review also needs ## Testverslag and ## Uitslag)",
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
      const fromStage = before.ticket.fields.stage;
      const actor = c.get("actor");
      const asHuman = isHumanProxyRequest(c);
      const ticket = await deps.service.transitionTicket(slug, body.to_stage, {
        comment: body.comment,
        author: actor.name,
        tokens_estimate: body.tokens_estimate,
        tokens_used: body.tokens_used,
        resolution: body.resolution,
        asHuman,
      });
      publishTicketEvent(
        ticketEventFromMapped("ticket.transitioned", mapTicket(ticket), {
          from_stage: fromStage,
          to_stage: ticket.fields.stage,
        }),
      );
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
    },
  );

  // Human review verdict: records the decision only. The agent still performs
  // the stage transition, gated on the verdict recorded here.
  app.post("/v1/tickets/:slug/review", requireScope("tickets:write"), async (c) => {
    if (!isHumanProxyRequest(c)) {
      return c.json(
        {
          message:
            "A review verdict can only be recorded by a signed-in human via the TraceAI UI (Goedkeuren/Afkeuren).",
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
    const existing = await deps.service.getTicket(param(c, "slug"));
    if (!existing) {
      return c.json({ message: "Ticket not found", code: "NOT_FOUND" }, 404);
    }
    const denied = await enforceProjectRole(
      deps.service,
      human,
      existing.ticket.fields.project,
      requiredRoleForAction("review"),
    );
    if (denied) {
      return c.json({ message: denied, code: "FORBIDDEN" }, 403);
    }
    const actor = c.get("actor");
    const result = await deps.service.recordReviewVerdict(param(c, "slug"), {
      verdict: body.verdict,
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
    const pages = await deps.service.listWikiPages({ project });
    return c.json(pages.map(mapWikiPage));
  });

  app.get("/v1/wiki-pages/:slug", requireScope("wiki:read"), async (c) => {
    const page = await deps.service.getWikiPage(param(c, "slug"));
    if (!page) {
      return c.json({ message: "Wiki page not found", code: "NOT_FOUND" }, 404);
    }
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
    const page = await deps.service.createWikiPage({
      ...body,
      updated_by: actor.name,
    });
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
      parent?: string | null;
      sort_order?: number;
    }>();
    const page = await deps.service.updateWikiPage(param(c, "slug"), {
      ...body,
      updated_by: actor.name,
    });
    audit(c, {
      action: "wiki.update",
      resourceType: "wiki_page",
      resourceId: page.slug,
      meta: { project: page.fields.project },
    });
    return c.json(mapWikiPage(page));
  });

  app.get("/v1/workflows", requireScope("workflows:read"), async (c) => {
    const project = c.req.query("project") ?? undefined;
    const workflows = await deps.service.listWorkflows(project);
    return c.json(workflows.map(mapWorkflow));
  });

  app.get("/v1/workflows/:slug", requireScope("workflows:read"), async (c) => {
    const result = await deps.service.getWorkflow(param(c, "slug"));
    if (!result) {
      return c.json({ message: "Workflow not found", code: "NOT_FOUND" }, 404);
    }
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
    const workflow = await deps.service.createWorkflow(body);
    audit(c, {
      action: "workflow.create",
      resourceType: "workflow",
      resourceId: workflow.slug,
    });
    return c.json(mapWorkflow(workflow), 201);
  });

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
      const human = resolveHumanIdentity(c);
      const denied = await enforceProjectRole(
        deps.service,
        human,
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
      const human = resolveHumanIdentity(c);
      const denied = await enforceProjectRole(
        deps.service,
        human,
        project,
        requiredRoleForAction("manage_members"),
      );
      if (denied) {
        // Token admins (no human identity) may still manage members.
        if (human || !hasScope(c.get("actor").scopes, ["admin"])) {
          return c.json({ message: denied, code: "FORBIDDEN" }, 403);
        }
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
      const human = resolveHumanIdentity(c);
      const denied = await enforceProjectRole(
        deps.service,
        human,
        project,
        requiredRoleForAction("manage_members"),
      );
      if (denied) {
        if (human || !hasScope(c.get("actor").scopes, ["admin"])) {
          return c.json({ message: denied, code: "FORBIDDEN" }, 403);
        }
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
      const projects = await projectsForHuman(deps.service, human);
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
    const message = err instanceof Error ? err.message : String(err);
    const status =
      /not found/i.test(message)
        ? 404
        : /not allowed|forbidden|disabled|human approval/i.test(message)
          ? 403
          : 400;
    return c.json({ message, code: "TRACE_ERROR" }, status);
  });

  return app;
}
