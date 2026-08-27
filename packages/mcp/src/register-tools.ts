import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TraceApiClient, TraceApiError } from "@traceai/core";
import { z } from "zod";

export const TRACEAI_MCP_NAME = "traceai";
export const TRACEAI_MCP_VERSION = "0.2.0";

function ok(data: unknown, apiBase: string) {
  // Always surface the API instance this process is bound to. Cursor can keep
  // multiple MCP processes alive after reload; api_base makes a mismatch obvious.
  const payload =
    data && typeof data === "object" && !Array.isArray(data)
      ? { ...data, api_base: apiBase }
      : { result: data, api_base: apiBase };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function okWrite(data: unknown, apiBase: string) {
  return ok(data, apiBase);
}

function fail(error: unknown) {
  return {
    content: [{ type: "text" as const, text: formatToolError(error) }],
    isError: true,
  };
}

const WIKI_409_HINT =
  " (Hint: the content changed under you — an anchor no longer matches uniquely. Re-read it (get_wiki_page) and patch again with a fresh anchor. Do NOT resend the same edits and do NOT fall back to a full body write.)";

const STAGE_CONFLICT_HINT =
  " (Hint: another actor moved this ticket or changed the verdict. Read current_stage, review_state and recent_comments above. Do NOT retry the same transition. Do NOT omit expected_stage to bypass the guard.)";

const HUMAN_GATE_OPEN_HINT =
  " (Hint: a human gate is still open. Read current_stage, review_state and allowed_targets. Wait for a TraceAI UI verdict. Do NOT retry the same transition. Do NOT omit expected_stage or expected_review_state to bypass the gate. Chat is not a verdict.)";

const INVALID_400_HINT =
  " (Hint: the request itself is invalid — resending it unchanged will fail again. Correct the field or the edit first.)";

/** Exported so M1/M2 can unit-test without spinning an MCP server. */
export function formatToolError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof TraceApiError ? error.status : undefined;
  const code = error instanceof TraceApiError ? error.code : undefined;
  const hint = /(^|\s)404($|\s)|TraceAI API 404/.test(message)
    ? " (Hint: a bare 404 usually means this MCP process is stale or pointing at the wrong TRACEAI_API_URL. Verify the API is up at TRACEAI_API_URL and reload the TraceAI MCP server in Cursor. Do NOT fall back to writing Aurora directly — that bypasses TraceAI and breaks the live board.)"
    : "";
  let classHint = "";
  let bodyDump = "";
  if (code === "STAGE_CONFLICT") {
    classHint = STAGE_CONFLICT_HINT;
    if (error instanceof TraceApiError && error.body != null) {
      bodyDump = `\n${JSON.stringify(error.body, null, 2)}`;
    }
  } else if (code === "HUMAN_GATE_OPEN") {
    classHint = HUMAN_GATE_OPEN_HINT;
    if (error instanceof TraceApiError && error.body != null) {
      bodyDump = `\n${JSON.stringify(error.body, null, 2)}`;
    }
  } else if (status === 409) {
    classHint = WIKI_409_HINT;
  } else if (status != null && status >= 500) {
    classHint =
      status === 502
        ? " (Hint: server or Aurora/upstream fault — do not rewrite a correct request. Retry later or tell an operator.)"
        : " (Hint: server/upstream fault — do not rewrite a correct request.)";
  } else if (status === 400) {
    classHint = INVALID_400_HINT;
  }
  const prefix = status
    ? `Error ${status}${code ? ` ${code}` : ""}: `
    : "Error: ";
  return `${prefix}${message}${bodyDump}${hint}${classHint}`;
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
    require_comment_sections_on_reject: z.array(z.string()).optional(),
    require_comment_sections_on_dismiss: z.array(z.string()).optional(),
    comment_template: z.string().optional(),
    require_tokens_estimate_on_exit: z.boolean().optional(),
    require_tokens_estimate_on_exit_to: z.array(z.string()).optional(),
    require_playbook_description_on_exit_to: z.array(z.string()).optional(),
    require_resolution_on_enter: z.boolean().optional(),
    require_human_approval_on_exit: z.boolean().optional(),
    human_approve_to: z.string().optional(),
    human_reject_to: z.array(z.string()).optional(),
    human_dismiss_to: z.string().optional(),
  })
  .passthrough()
  .optional();

const stageSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  transitions: z.array(z.string()),
  agent: stageAgentSchema,
});

/** Register the full TraceAI tool surface on an MCP server (stdio or HTTP). */
export function registerTraceAiTools(
  server: McpServer,
  client: TraceApiClient,
): void {
  const apiBase = client.apiUrl;

  server.tool(
    "list_projects",
    "List TraceAI projects available to the agent",
    {},
    async () => {
      try {
        return ok(await client.listProjects(), apiBase);
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
        return ok(await client.getProject(slug), apiBase);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "create_project",
    "Create a new project with Standard Worker workflow (default), optional handbook wiki seed, and optional owner membership. Prefer this over inventing a second create tool.",
    {
      name: z.string().min(1),
      description: z.string().optional(),
      slug: z.string().optional(),
      seed_workflow: z.boolean().optional().default(true),
      seed_wiki: z.boolean().optional().default(true),
      owner_user: z
        .string()
        .optional()
        .describe("traceai_user slug to grant admin membership"),
    },
    async (input) => {
      try {
        return okWrite(await client.createProject(input), apiBase);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "list_tickets",
    "List tickets for a project. Optional stage, parent, and workflow filters. workflow is an exact pin match; omit it to return every ticket in the project. Each row includes tokens_estimate_rollup (own + descendants).",
    {
      project: z.string().describe("Project slug"),
      stage: z.string().optional().describe("Stage key filter"),
      parent: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Parent ticket slug filter; null/empty for root tickets only",
        ),
      workflow: z
        .string()
        .optional()
        .describe("Exact workflow-slug pin; omit for the full project set"),
    },
    async ({ project, stage, parent, workflow }) => {
      try {
        return ok(
          await client.listTickets(project, stage, parent, workflow),
          apiBase,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "search_project",
    "BM25 search over tickets (including Done and comments) and wiki within one project. Returns compact ranked hits; open only relevant results with get_ticket/get_wiki_page. Use focused for lookups, balanced by default, and broad only for inventories. Prefixes of 3+ letters match; 1–2 letter queries return no hits.",
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
      profile: z
        .enum(["focused", "balanced", "broad"])
        .optional()
        .describe("Retrieval budget; defaults to balanced"),
      include_preview: z
        .boolean()
        .optional()
        .describe("Include compact snippets; defaults to true"),
      limit: z.number().int().positive().max(100).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    async (input) => {
      try {
        const { project, ...query } = input;
        return ok(await client.searchProject(project, query), apiBase);
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
          apiBase,
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
        return ok(await client.getProjectInsights(project), apiBase);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "get_estimate_vs_actual",
    "Estimate vs actual for recent comparable Done tickets, sliced by tokens_actual size. Aggregates only (no ticket rows). Default limit 50, default breakpoints 20k/80k.",
    {
      project: z.string().describe("Project slug"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Last N comparable Done tickets; default 50"),
      breakpoints: z
        .array(z.number().int().positive())
        .min(1)
        .max(8)
        .optional()
        .describe(
          "Strictly increasing tokens_actual bucket edges; default [20000, 80000]",
        ),
    },
    async ({ project, limit, breakpoints }) => {
      try {
        return ok(
          await client.getEstimateVsActual(project, { limit, breakpoints }),
          apiBase,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "get_ticket",
    "Get a ticket by slug OR exact ticket_key (e.g. TRA-42), including comments, parent_ticket, children, and tokens_*_rollup (own + descendants).",
    { slug: z.string().describe("Ticket slug or ticket_key (TRA-42)") },
    async ({ slug }) => {
      try {
        return ok(await client.getTicket(slug), apiBase);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "create_ticket",
    "Create and publish a ticket. Description MUST be self-contained for junior agents (Context/Goal/What to implement/Acceptance criteria). Optional parent (slug or TRA-n) links it as a subticket. Actor comes from TraceAI token.",
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
      parent: z
        .string()
        .nullable()
        .optional()
        .describe("Parent ticket slug or key (TRA-n); same project only"),
    },
    async (input) => {
      try {
        return okWrite(await client.createTicket(input), apiBase);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "update_ticket",
    "Update ticket title, description, priority, tokens_estimate, resolution, or parent (slug/TRA-n; empty/null clears).",
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
      parent: z
        .string()
        .nullable()
        .optional()
        .describe("Parent ticket slug or key; empty/null clears the link"),
    },
    async ({ slug, ...body }) => {
      try {
        return okWrite(await client.updateTicket(slug, body), apiBase);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "claim_ticket",
    "Claim this ticket for the calling agent (last writer wins). Pass your Cursor agent id. On Cursor-managed Cloud Agent VMs read it from the metadata socket, not the dashboard URL: curl -fsS --unix-socket \"${CURSOR_AGENT_SOCKET:-/run/cursor/api.sock}\" http://cursor-agent/v1/meta-data/agent/id . Fallback: Cloud MCP run-info → bcId. Empty agent_id clears the claim. Cloud ids start with bc- and receive a wake-up after a human-gate verdict. Call this before transition_ticket into a stage with require_human_approval_on_exit.",
    {
      ticket: z.string().describe("Ticket slug or TRA-n"),
      agent_id: z
        .string()
        .describe(
          "Cursor agent id (bc-… for Cloud). Empty string clears the claim.",
        ),
    },
    async ({ ticket, agent_id }) => {
      try {
        return okWrite(await client.claimTicket(ticket, agent_id), apiBase);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "set_default_agent",
    "Set this TraceAI user as using the given Cursor Cloud agent as the default. That agent is nudged (and claimed) when a new ticket lands on Backlog. Pass your Cursor agent id. On Cursor-managed Cloud Agent VMs read it from the metadata socket, not the dashboard URL: curl -fsS --unix-socket \"${CURSOR_AGENT_SOCKET:-/run/cursor/api.sock}\" http://cursor-agent/v1/meta-data/agent/id . Fallback: Cloud MCP run-info → bcId. Empty agent_id clears the default. Non-bc- ids may be stored but are never nudged.",
    {
      agent_id: z
        .string()
        .describe(
          "Cursor agent id (bc-… for Cloud). Empty string clears the default.",
        ),
    },
    async ({ agent_id }) => {
      try {
        return okWrite(await client.putMyDefaultAgent(agent_id), apiBase);
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
        return okWrite(await client.addComment(input), apiBase);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "transition_ticket",
    "Move a ticket to another workflow stage. Required Markdown headings are only those on get_workflow: agent_policy.require_comment_sections, per-stage require_comment_sections_on_enter/on_exit, and require_comment_sections_on_reject/on_dismiss. If those lists are empty, a short comment without ## headings is enough. Token/resolution fields are required only when the workflow playbook says so (see get_workflow): tokens_used when agent_policy.require_tokens_used_on_transition; tokens_estimate when leaving a stage with require_tokens_estimate_on_exit; resolution when entering a stage with require_resolution_on_enter. Call get_ticket immediately before this tool and pass expected_stage (the current stage). On a human-gated stage also pass expected_review_state (current review_state, or null). Workflows with require_expected_stage_on_transition refuse the call without those fields. On 409 STAGE_CONFLICT the error includes current_stage, review_state and recent_comments — do not retry the same transition. On 409 HUMAN_GATE_OPEN the current stage still needs a UI verdict, or the chosen hop skips a gated stage; the body has current_stage, review_state and allowed_targets — do not retry, do not omit expected_* . Chat is not a verdict. This tool has no asHuman override. A stage with require_human_approval_on_exit may only be left after a human recorded a verdict in the TraceAI UI: get_ticket then shows review_state approved (move to human_approve_to), rejected (move to a human_reject_to target) or dismissed (move to human_dismiss_to). Reject/dismiss comments must be non-empty and include any headings those stage lists name. Only the outcomes the stage actually configures are available. Without a verdict the transition is refused; the verdict is cleared once the ticket moves.",
    {
      slug: z.string(),
      to_stage: z.string().describe("Target stage key"),
      comment: z
        .string()
        .min(40)
        .describe(
          "Markdown transition comment. Required sections depend on workflow agent rules.",
        ),
      expected_stage: z
        .string()
        .optional()
        .describe(
          "Stage you just read from get_ticket. Required when the workflow sets require_expected_stage_on_transition (agents). Mismatch → 409 STAGE_CONFLICT.",
        ),
      expected_review_state: z
        .union([z.string(), z.null()])
        .optional()
        .describe(
          "review_state you just read (or null). Required on human-gated stages when the workflow requires expected_stage. Pass null explicitly when you expect no verdict.",
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
      expected_stage,
      expected_review_state,
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
            expected_stage,
            ...(expected_review_state !== undefined
              ? { expected_review_state }
              : {}),
          }),
          apiBase,
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
        return ok(await client.listWorkflows(project), apiBase);
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
        return ok(await client.getWorkflow(slug), apiBase);
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
        return okWrite(await client.createWorkflow(input), apiBase);
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
        return okWrite(await client.updateWorkflow(slug, body), apiBase);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "list_wiki_pages",
    "List wiki pages for a project (read-only tree nodes: slug, title, parent, sort_order). Page bodies are NOT included — use get_wiki_page for content. Returns {items, total, limit, offset}; compare total with items.length to see whether you got the whole tree. Cursor must use TraceAI MCP only — never Aurora MCP for wiki entries.",
    {
      project: z.string().describe("Project slug"),
      parent: z
        .string()
        .optional()
        .describe("Only direct children of this page slug; empty string for root pages"),
      include_body: z
        .boolean()
        .optional()
        .describe("Include Markdown bodies. Off by default — a full tree with bodies can exceed the context window"),
      limit: z.number().int().optional(),
      offset: z.number().int().optional(),
    },
    async ({ project, ...query }) => {
      try {
        return ok(await client.listWikiPages(project, query), apiBase);
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
        return ok(await client.getWikiPage(slug), apiBase);
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
        return okWrite(await client.createWikiPage(input), apiBase);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "update_wiki_page",
    "Update a wiki page. PREFER `edits` over `body`: each edit replaces one exact fragment, so everything you did not touch stays byte-identical — no need to resend an 11k-character page to change one table row, and no risk of silently dropping a section you forgot. Use `body` only for a new page or a full rewrite. Each `old_string` must appear EXACTLY once (or set replace_all); copy it verbatim from get_wiki_page, including whitespace, and extend it until it is unique rather than guessing. Errors tell you what to do next: 409 = the page changed and your anchor is stale → re-read and patch again; 400 = your request is wrong → fix it, resending unchanged will fail again. Nothing is written when an edit fails. Never use Aurora MCP for wiki entries.",
    {
      slug: z.string(),
      title: z.string().min(1).optional(),
      body: z
        .string()
        .optional()
        .describe("Full replacement Markdown. Mutually exclusive with edits"),
      edits: z
        .array(
          z.object({
            old_string: z
              .string()
              .min(1)
              .describe("Exact fragment to replace; must match uniquely"),
            new_string: z.string().describe("Replacement (empty string deletes)"),
            replace_all: z
              .boolean()
              .optional()
              .describe("Replace every occurrence instead of requiring one"),
          }),
        )
        .optional()
        .describe(
          "Patch fragments of the page body, applied in order. Preferred over body",
        ),
      parent: z.string().nullable().optional(),
      sort_order: z.number().int().optional(),
    },
    async ({ slug, ...body }) => {
      try {
        return okWrite(await client.updateWikiPage(slug, body), apiBase);
      } catch (error) {
        return fail(error);
      }
    },
  );
}

export function createTraceAiMcpServer(client: TraceApiClient): McpServer {
  const server = new McpServer({
    name: TRACEAI_MCP_NAME,
    version: TRACEAI_MCP_VERSION,
  });
  registerTraceAiTools(server, client);
  return server;
}
