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
    comment_template: z.string().optional(),
  })
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
    "Update ticket title, description, or priority",
    {
      slug: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      priority: z.enum(["low", "medium", "high"]).optional(),
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
    "Move a ticket to another workflow stage. ALWAYS pass comment with ## Vorige stap and ## Deze stap. Entering review ALSO requires ## Testverslag and ## Uitslag (PASS/FAIL).",
    {
      slug: z.string(),
      to_stage: z.string().describe("Target stage key"),
      comment: z
        .string()
        .min(40)
        .describe(
          "Markdown transition comment. Required sections depend on workflow agent rules.",
        ),
    },
    async ({ slug, to_stage, comment }) => {
      try {
        return okWrite(await client.transitionTicket(slug, to_stage, comment));
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
