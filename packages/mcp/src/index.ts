#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TraceApiClient } from "@traceai/core";
import { z } from "zod";

function resolveApiUrl(): string {
  const raw = process.env.TRACEAI_API_URL?.trim();
  if (!raw) {
    throw new Error(
      "Set TRACEAI_API_URL in the TraceAI MCP env (e.g. https://traceai.joostvanleeuwaarden.com). Refusing to default to localhost — that silently breaks the live board when Cursor keeps a stale MCP process.",
    );
  }
  const apiUrl = raw.replace(/\/+$/, "");
  // Hard reject loopback: Cursor sometimes keeps orphan MCP processes that were
  // started with an old TRACEAI_API_URL. Fail loudly instead of writing to the
  // wrong instance.
  if (/^(https?:\/\/)?(127\.0\.0\.1|localhost)([:/]|$)/i.test(apiUrl)) {
    throw new Error(
      `TRACEAI_API_URL must not be loopback (${apiUrl}). Point MCP at the public TraceAI API (https://traceai.joostvanleeuwaarden.com), run node scripts/cleanup-traceai-mcp.mjs, and reload the MCP server.`,
    );
  }
  return apiUrl;
}

function createClient(): TraceApiClient {
  const apiUrl = resolveApiUrl();
  const token = process.env.TRACEAI_TOKEN;
  if (!token) {
    throw new Error(
      "Set TRACEAI_TOKEN (trc_…) — TraceAI MCP no longer accepts Aurora credentials",
    );
  }
  if (!token.startsWith("trc_")) {
    throw new Error("TRACEAI_TOKEN must start with trc_");
  }
  return new TraceApiClient({ apiUrl, token });
}

function ok(data: unknown) {
  // Always surface the API instance this process is bound to. Cursor can keep
  // multiple MCP processes alive after reload; api_base makes a mismatch obvious.
  const payload =
    data && typeof data === "object" && !Array.isArray(data)
      ? { ...data, api_base: resolveApiUrl() }
      : { result: data, api_base: resolveApiUrl() };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Writes use the same envelope as reads; kept as an alias so call sites stay explicit.
 */
function okWrite(data: unknown) {
  return ok(data);
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const hint = /(^|\s)404($|\s)|TraceAI API 404/.test(message)
    ? " (Hint: a bare 404 usually means this MCP process is stale or pointing at the wrong TRACEAI_API_URL. Verify the API is up at TRACEAI_API_URL and reload the TraceAI MCP server in Cursor. Do NOT fall back to writing Aurora directly — that bypasses TraceAI and breaks the live board.)"
    : "";
  return {
    content: [{ type: "text" as const, text: `Error: ${message}${hint}` }],
    isError: true,
  };
}

const stageAgentSchema = z
  .object({
    purpose: z.string().optional(),
    on_enter: z.array(z.string()).optional(),
    on_exit: z.array(z.string()).optional(),
    require_comment_on_enter: z.boolean().optional(),
    require_comment_on_exit: z.boolean().optional(),
    require_comment_sections_on_enter: z.array(z.string()).optional(),
    require_comment_sections_on_exit: z.array(z.string()).optional(),
    comment_template: z.string().optional(),
    require_tokens_estimate_on_exit: z.boolean().optional(),
    require_tokens_estimate_on_exit_to: z.array(z.string()).optional(),
    require_playbook_description_on_exit_to: z.array(z.string()).optional(),
    require_resolution_on_enter: z.boolean().optional(),
    require_human_approval_on_exit: z.boolean().optional(),
    human_approve_to: z.string().optional(),
    human_reject_to: z.array(z.string()).optional(),
  })
  .passthrough()
  .optional();

const stageSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  transitions: z.array(z.string()),
  agent: stageAgentSchema,
});

async function main() {
  const client = createClient();
  const server = new McpServer({
    name: "traceai",
    version: "0.2.0",
  });

  server.tool(
    "list_projects",
    "List TraceAI projects available to the agent",
    {},
    async () => {
      try {
        return ok(await client.listProjects());
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "get_project",
    "Get a project with workflow stages AND the agent_playbook (required working agreements: rich ticket descriptions, transition comments, review test reports).",
    { slug: z.string().describe("Project slug") },
    async ({ slug }) => {
      try {
        return ok(await client.getProject(slug));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "create_project",
    "Create a new project and optional default workflow",
    {
      name: z.string().min(1),
      description: z.string().optional(),
      slug: z.string().optional(),
      seed_workflow: z.boolean().optional().default(true),
    },
    async (input) => {
      try {
        return okWrite(await client.createProject(input));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "list_tickets",
    "List tickets for a project, optionally filtered by stage",
    {
      project: z.string().describe("Project slug"),
      stage: z.string().optional().describe("Stage key filter"),
    },
    async ({ project, stage }) => {
      try {
        return ok(await client.listTickets(project, stage));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "search_project",
    "Search tickets (key/title/description/comments) and wiki (title/body) within one project. Supports filters: stage, resolution, priority, created_by/actor, from/to dates, type.",
    {
      project: z.string().describe("Project slug"),
      q: z.string().optional().describe("Free-text query"),
      type: z
        .enum(["all", "ticket", "wiki_page"])
        .optional()
        .describe("Result type filter"),
      stage: z.string().optional(),
      resolution: z.string().optional(),
      priority: z.enum(["low", "medium", "high"]).optional(),
      created_by: z
        .string()
        .optional()
        .describe("Ticket created_by or comment author"),
      from: z.string().optional().describe("ISO date lower bound"),
      to: z.string().optional().describe("ISO date upper bound"),
      limit: z.number().int().positive().max(100).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    async (input) => {
      try {
        const { project, ...query } = input;
        return ok(await client.searchProject(project, query));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "list_project_history",
    "Paginated ticket history for a project (no board Done ~20 display cap). Defaults to all stages; pass stage=done for full Done archive.",
    {
      project: z.string().describe("Project slug"),
      stage: z.string().optional().describe("Stage key, e.g. done"),
      limit: z.number().int().positive().max(100).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    async ({ project, stage, limit, offset }) => {
      try {
        return ok(
          await client.listProjectHistory(project, { stage, limit, offset }),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "get_project_insights",
    "Delivery metrics for a project: throughput/week, open WIP age, estimate vs actual, resolution mix. review_returns deferred until durable events (TRA-29).",
    { project: z.string().describe("Project slug") },
    async ({ project }) => {
      try {
        return ok(await client.getProjectInsights(project));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "get_ticket",
    "Get a ticket by slug OR exact ticket_key (e.g. TRA-42), including comments",
    { slug: z.string().describe("Ticket slug or ticket_key (TRA-42)") },
    async ({ slug }) => {
      try {
        return ok(await client.getTicket(slug));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "create_ticket",
    "Create and publish a ticket. Description MUST be self-contained for junior agents (Context/Goal/What to implement/Acceptance criteria). Actor comes from TraceAI token.",
    {
      project: z.string(),
      title: z.string().min(1),
      description: z
        .string()
        .min(280)
        .describe(
          "Full Markdown description with ## Context, ## Goal, ## What to implement, ## Acceptance criteria",
        ),
      priority: z.enum(["low", "medium", "high"]).optional(),
      workflow: z.string().optional(),
      stage: z.string().optional(),
      slug: z.string().optional(),
    },
    async (input) => {
      try {
        return okWrite(await client.createTicket(input));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "update_ticket",
    "Update ticket title, description, priority, tokens_estimate, or resolution",
    {
      slug: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      priority: z.enum(["low", "medium", "high"]).optional(),
      tokens_estimate: z.number().int().nonnegative().optional(),
      resolution: z
        .enum([
          "completed",
          "superseded",
          "cancelled",
          "duplicate",
          "verification-only",
        ])
        .optional(),
    },
    async ({ slug, ...body }) => {
      try {
        return okWrite(await client.updateTicket(slug, body));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "add_comment",
    "Add a Markdown comment to a ticket (author comes from TraceAI token)",
    {
      ticket: z.string().describe("Ticket slug"),
      body: z.string().min(1),
    },
    async (input) => {
      try {
        return okWrite(await client.addComment(input));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "transition_ticket",
    "Move a ticket to another workflow stage. ALWAYS pass comment with ## Vorige stap and ## Deze stap. Entering review ALSO requires ## Testverslag and ## Uitslag (PASS/FAIL). Token/resolution fields are required only when the workflow playbook says so (see get_workflow): tokens_used when agent_policy.require_tokens_used_on_transition; tokens_estimate when leaving a stage with require_tokens_estimate_on_exit; resolution when entering a stage with require_resolution_on_enter. A stage with require_human_approval_on_exit may only be left after a human recorded a verdict in the TraceAI UI: get_ticket then shows review_state approved (move to human_approve_to) or rejected (move to human_reject_to, comment needs ## Reden). Without a verdict the transition is refused; the verdict is cleared once the ticket moves.",
    {
      slug: z.string(),
      to_stage: z.string().describe("Target stage key"),
      comment: z
        .string()
        .min(40)
        .describe(
          "Markdown transition comment. Required sections depend on workflow agent rules.",
        ),
      tokens_used: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Self-reported LLM token delta for this step. Required when agent_policy.require_tokens_used_on_transition is true.",
        ),
      tokens_estimate: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "LLM token estimate for the whole ticket. Required when leaving a stage with require_tokens_estimate_on_exit.",
        ),
      resolution: z
        .enum([
          "completed",
          "superseded",
          "cancelled",
          "duplicate",
          "verification-only",
        ])
        .optional()
        .describe(
          "Closure reason. Required when entering a stage with require_resolution_on_enter.",
        ),
    },
    async ({
      slug,
      to_stage,
      comment,
      tokens_used,
      tokens_estimate,
      resolution,
    }) => {
      try {
        return okWrite(
          await client.transitionTicket(slug, to_stage, comment, {
            tokens_used,
            tokens_estimate,
            resolution,
          }),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "list_workflows",
    "List workflows, optionally for one project",
    { project: z.string().optional() },
    async ({ project }) => {
      try {
        return ok(await client.listWorkflows(project));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "get_workflow",
    "Get a workflow including stages and agent_policy (always read this before creating tickets or transitioning).",
    { slug: z.string() },
    async ({ slug }) => {
      try {
        return ok(await client.getWorkflow(slug));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "create_workflow",
    "Create a workflow for a project. New workflows get the default agent_policy (rich descriptions, transition comments, review test reports).",
    {
      name: z.string().min(1),
      project: z.string(),
      slug: z.string().optional(),
      stages: z.array(stageSchema).optional(),
    },
    async (input) => {
      try {
        return okWrite(await client.createWorkflow(input));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "update_workflow",
    "Update workflow name, stages, and/or full document (agent_policy + stages). Prefer passing document to set agent playbook rules.",
    {
      slug: z.string(),
      name: z.string().optional(),
      stages: z.array(stageSchema).optional(),
      document: z
        .object({
          version: z.number().optional(),
          agent_policy: z.record(z.unknown()).optional(),
          stages: z.array(stageSchema).optional(),
        })
        .optional(),
      agent_policy: z.record(z.unknown()).optional(),
    },
    async ({ slug, ...body }) => {
      try {
        return okWrite(await client.updateWorkflow(slug, body));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "list_wiki_pages",
    "List wiki pages for a project (read-only tree nodes). Cursor must use TraceAI MCP only — never Aurora MCP for wiki entries.",
    { project: z.string().describe("Project slug") },
    async ({ project }) => {
      try {
        return ok(await client.listWikiPages(project));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "get_wiki_page",
    "Get a wiki page by slug. Cursor → TraceAI only (never Aurora MCP).",
    { slug: z.string() },
    async ({ slug }) => {
      try {
        return ok(await client.getWikiPage(slug));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "create_wiki_page",
    "Create a Markdown wiki page under a project. UI is read-only — agents write here. Never use Aurora MCP for wiki entries (Cursor → TraceAI → Aurora).",
    {
      project: z.string(),
      title: z.string().min(1),
      body: z.string().optional().describe("Markdown body"),
      parent: z
        .string()
        .optional()
        .describe("Parent wiki page slug; omit for root"),
      sort_order: z.number().int().optional(),
      slug: z.string().optional(),
    },
    async (input) => {
      try {
        return okWrite(await client.createWikiPage(input));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "update_wiki_page",
    "Update a wiki page (title/body/parent/sort_order). Never use Aurora MCP for wiki entries.",
    {
      slug: z.string(),
      title: z.string().min(1).optional(),
      body: z.string().optional(),
      parent: z.string().nullable().optional(),
      sort_order: z.number().int().optional(),
    },
    async ({ slug, ...body }) => {
      try {
        return okWrite(await client.updateWikiPage(slug, body));
      } catch (error) {
        return fail(error);
      }
    },
  );

  // stderr only — stdout is the MCP JSON-RPC transport.
  console.error(
    `[traceai-mcp] bound to ${resolveApiUrl()} (pid ${process.pid})`,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
