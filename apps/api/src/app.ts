import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { AuthStore } from "@traceai/auth";
import type { TraceService } from "@traceai/core";
import { parseWorkflowDocument } from "@traceai/core";
import {
  publishTicketEvent,
  subscribeTicketEvents,
  ticketEventFromMapped,
} from "./events.js";
import {
  audit,
  createAuthMiddleware,
  requireScope,
  requestIdMiddleware,
  type AppVariables,
} from "./middleware.js";

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
  };
}

function mapWorkflow(w: Awaited<ReturnType<TraceService["listWorkflows"]>>[number]) {
  return {
    slug: w.slug,
    name: w.fields.name,
    project: w.fields.project,
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
      allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "x-request-id"],
      exposeHeaders: ["x-request-id"],
    }),
  );

  app.use("*", requestIdMiddleware());

  app.get("/health", (c) => c.json({ status: "ok", service: "traceai-api" }));

  // Public SSE stream for read-only live boards (no bearer token).
  app.get("/events", (c) => {
    const projectFilter = c.req.query("project") ?? undefined;
    return streamSSE(c, async (stream) => {
      let closed = false;
      const unsubscribe = subscribeTicketEvents((event) => {
        if (projectFilter && event.project !== projectFilter) return;
        void stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        });
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
          at: new Date().toISOString(),
        }),
      });

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

  app.get("/v1/projects", requireScope("projects:read"), async (c) => {
    const projects = await deps.service.listProjects();
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
    }>();
    if (!body?.name?.trim()) {
      return c.json({ message: "name is required", code: "VALIDATION" }, 400);
    }
    const result = await deps.service.createProject({
      name: body.name,
      description: body.description,
      slug: body.slug,
      seedWorkflow: body.seed_workflow,
    });
    audit(c, {
      action: "project.create",
      resourceType: "project",
      resourceId: result.project.slug,
    });
    return c.json(
      {
        project: mapProject(result.project),
        workflow: result.workflow ? mapWorkflow(result.workflow) : null,
      },
      201,
    );
  });

  app.get("/v1/tickets", requireScope("tickets:read"), async (c) => {
    const project = c.req.query("project");
    if (!project) {
      return c.json(
        { message: "project query param is required", code: "VALIDATION" },
        400,
      );
    }
    const stage = c.req.query("stage") ?? undefined;
    const tickets = await deps.service.listTickets({ project, stage });
    return c.json(
      tickets.map((t) => ({
        slug: t.slug,
        ticket_key: t.fields.ticket_key ?? null,
        ticket_number: t.fields.ticket_number ?? null,
        title: t.fields.title,
        stage: t.fields.stage,
        priority: t.fields.priority ?? "medium",
        workflow: t.fields.workflow,
        created_by: t.fields.created_by ?? null,
      })),
    );
  });

  app.get("/v1/tickets/:slug", requireScope("tickets:read"), async (c) => {
    const result = await deps.service.getTicket(param(c, "slug"));
    if (!result) {
      return c.json({ message: "Ticket not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({
      ...mapTicket(result.ticket),
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
    const body = await c.req.json<{
      project: string;
      title: string;
      description?: string;
      priority?: string;
      workflow?: string;
      stage?: string;
      slug?: string;
    }>();
    if (!body?.project || !body?.title?.trim()) {
      return c.json(
        { message: "project and title are required", code: "VALIDATION" },
        400,
      );
    }
    const ticket = await deps.service.createTicket({
      project: body.project,
      title: body.title,
      description: body.description,
      priority: body.priority,
      workflow: body.workflow,
      stage: body.stage,
      slug: body.slug,
      created_by: actor.name,
    });
    const mapped = mapTicket(ticket);
    publishTicketEvent(ticketEventFromMapped("ticket.created", mapped));
    audit(c, {
      action: "ticket.create",
      resourceType: "ticket",
      resourceId: ticket.slug,
    });
    return c.json(mapped, 201);
  });

  app.patch("/v1/tickets/:slug", requireScope("tickets:write"), async (c) => {
    const body = await c.req.json<{
      title?: string;
      description?: string;
      priority?: string;
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

  app.post(
    "/v1/tickets/:slug/transition",
    requireScope("tickets:write"),
    async (c) => {
      const body = await c.req.json<{ to_stage: string; comment?: string }>();
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
      const ticket = await deps.service.transitionTicket(slug, body.to_stage, {
        comment: body.comment,
        author: actor.name,
      });
      const mapped = mapTicket(ticket);
      publishTicketEvent(
        ticketEventFromMapped("ticket.transitioned", mapped, {
          from_stage: fromStage,
          to_stage: ticket.fields.stage,
        }),
      );
      audit(c, {
        action: "ticket.transition",
        resourceType: "ticket",
        resourceId: ticket.slug,
        meta: { from_stage: fromStage, to_stage: body.to_stage },
      });
      return c.json({
        slug: ticket.slug,
        ticket_key: ticket.fields.ticket_key ?? null,
        stage: ticket.fields.stage,
        title: ticket.fields.title,
        from_stage: fromStage,
      });
    },
  );

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
        : /not allowed|forbidden|disabled/i.test(message)
          ? 403
          : 400;
    return c.json({ message, code: "TRACE_ERROR" }, status);
  });

  return app;
}
