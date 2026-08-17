import {
  AURORA_FIELD_IN_MAX,
  AuroraPublicClient,
  TraceApiClient,
  computeProjectInsights,
  lastStageKey,
  newestFirstCapped,
  paginateItems,
  parseStages,
  relationSlug,
  searchProjectContent,
  sortTicketsNewestFirst,
  type Comment,
  type Project,
  type ProjectInsights,
  type SearchHit,
  type Ticket,
  type WikiPage,
  type Workflow,
  type WorkflowStage,
} from "@traceai/core";

const apiUrl =
  process.env.NEXT_PUBLIC_CMS_API_URL ??
  "https://aurora-api.joostvanleeuwaarden.com";
const siteKey = process.env.NEXT_PUBLIC_CMS_SITE_KEY ?? "";

export function getPublicClient() {
  if (!siteKey) {
    throw new Error("NEXT_PUBLIC_CMS_SITE_KEY is not set");
  }
  return new AuroraPublicClient({ apiUrl, siteKey, locale: "en-US" });
}

export async function listProjects(): Promise<Project[]> {
  const client = getPublicClient();
  const result = await client.listEntries<Project>("project", { limit: 100 });
  return result.items;
}

export async function getProject(slug: string): Promise<Project | null> {
  try {
    return await getPublicClient().getEntry<Project>("project", slug);
  } catch {
    return null;
  }
}

export async function getWorkflow(slug: string): Promise<Workflow | null> {
  try {
    return await getPublicClient().getEntry<Workflow>("workflow", slug);
  } catch {
    return null;
  }
}

export async function listWorkflowsForProject(
  projectSlug: string,
): Promise<Workflow[]> {
  const result = await getPublicClient().listEntries<Workflow>("workflow", {
    limit: 100,
  });
  return result.items.filter((w) => w.fields.project === projectSlug);
}

export async function listTicketsForProject(
  projectSlug: string,
): Promise<Ticket[]> {
  const result = await getPublicClient().listEntries<Ticket>("ticket", {
    limit: 100,
  });
  return result.items
    .filter((t) => t.fields.project === projectSlug)
    .sort((a, b) => (a.fields.sort_order ?? 0) - (b.fields.sort_order ?? 0));
}

export async function getTicket(slug: string): Promise<Ticket | null> {
  try {
    return await getPublicClient().getEntry<Ticket>("ticket", slug);
  } catch {
    return null;
  }
}

export async function listCommentsForTicket(
  ticketSlug: string,
): Promise<Comment[]> {
  const client = getPublicClient();
  const pageSize = 100;
  const items: Comment[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const result = await client.listEntries<Comment>("comment", {
      limit: pageSize,
      offset,
      field: "ticket",
      in: ticketSlug,
    });
    items.push(...result.items);
    if (result.items.length < pageSize || items.length >= result.total) break;
  }
  return items.sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

async function listCommentsForTickets(
  ticketSlugs: readonly string[],
): Promise<Comment[]> {
  const unique = [
    ...new Set(ticketSlugs.map((s) => s.trim()).filter(Boolean)),
  ];
  if (unique.length === 0) return [];
  const client = getPublicClient();
  const pageSize = 100;
  const out: Comment[] = [];
  for (let i = 0; i < unique.length; i += AURORA_FIELD_IN_MAX) {
    const chunk = unique.slice(i, i + AURORA_FIELD_IN_MAX);
    const chunkItems: Comment[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const result = await client.listEntries<Comment>("comment", {
        limit: pageSize,
        offset,
        field: "ticket",
        in: chunk,
      });
      chunkItems.push(...result.items);
      if (
        result.items.length < pageSize ||
        chunkItems.length >= result.total
      ) {
        break;
      }
    }
    out.push(...chunkItems);
  }
  return out;
}

export type WikiTreeNode = {
  slug: string;
  title: string;
  parent: string | null;
  children: WikiTreeNode[];
};

/** Coerce Aurora relation field (slug string or `{ slug }`) to a slug. */
function wikiRelationSlug(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "object" && value !== null && "slug" in value) {
    const slug = (value as { slug?: unknown }).slug;
    if (typeof slug === "string" && slug.trim()) return slug.trim();
  }
  return null;
}

export async function listWikiPagesForProject(projectSlug: string): Promise<{
  pages: WikiPage[];
  tree: WikiTreeNode[];
}> {
  const result = await getPublicClient().listEntries<WikiPage>("wiki_page", {
    limit: 100,
  });
  const pages = result.items
    .filter((p) => wikiRelationSlug(p.fields.project) === projectSlug)
    .sort((a, b) => {
      const so = (a.fields.sort_order ?? 0) - (b.fields.sort_order ?? 0);
      if (so !== 0) return so;
      return a.fields.title.localeCompare(b.fields.title);
    });

  const bySlug = new Map<string, WikiTreeNode>();
  for (const page of pages) {
    bySlug.set(page.slug, {
      slug: page.slug,
      title: page.fields.title,
      parent: wikiRelationSlug(page.fields.parent),
      children: [],
    });
  }
  const roots: WikiTreeNode[] = [];
  for (const node of bySlug.values()) {
    if (node.parent && bySlug.has(node.parent)) {
      bySlug.get(node.parent)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return { pages, tree: roots };
}

export async function getWikiPage(slug: string): Promise<WikiPage | null> {
  try {
    return await getPublicClient().getEntry<WikiPage>("wiki_page", slug);
  } catch {
    return null;
  }
}

/** Board card shape shared with `LiveBoard` (camelCase, source-agnostic). */
export type BoardTicketSnapshot = {
  slug: string;
  ticketKey: string | null;
  title: string;
  stage: string;
  priority: string;
  stageChangedAt?: string;
  tokensEstimate: number | null;
  tokensActual: number | null;
  resolution: string | null;
  reviewState: string | null;
  sortOrder: number | null;
};

function getTraceClient(): TraceApiClient | null {
  const traceApiUrl = process.env.TRACEAI_API_URL?.replace(/\/$/, "");
  const token = process.env.TRACEAI_TOKEN;
  if (!traceApiUrl || !token || !token.startsWith("trc_")) return null;
  return new TraceApiClient({ apiUrl: traceApiUrl, token });
}

/**
 * Initial board tickets via the TraceAI API (system of record proxy) instead
 * of reading Aurora directly, so the live-board path has a single source of
 * truth that matches the SSE stream. Returns `null` when TraceAI is not
 * configured on the web server, so callers can fall back to Aurora.
 */
export async function listBoardTicketsViaTraceAI(
  projectSlug: string,
): Promise<BoardTicketSnapshot[] | null> {
  const client = getTraceClient();
  if (!client) return null;
  try {
    const rows = (await client.listTickets(projectSlug)) as Array<{
      slug: string;
      ticket_key?: string | null;
      title: string;
      stage: string;
      priority?: string | null;
      stage_entered_at?: string | null;
      tokens_estimate?: number | null;
      tokens_actual?: number | null;
      resolution?: string | null;
      review_state?: string | null;
      sort_order?: number | null;
    }>;
    return rows.map((t) => ({
      slug: t.slug,
      ticketKey: t.ticket_key ?? null,
      title: t.title,
      stage: t.stage,
      priority: t.priority ?? "medium",
      stageChangedAt: t.stage_entered_at ?? undefined,
      tokensEstimate: t.tokens_estimate ?? null,
      tokensActual: t.tokens_actual ?? null,
      resolution: t.resolution ?? null,
      reviewState: t.review_state || null,
      sortOrder: t.sort_order ?? null,
    }));
  } catch {
    return null;
  }
}

export async function getProjectBoard(projectSlug: string): Promise<{
  project: Project;
  workflow: Workflow | null;
  stages: WorkflowStage[];
  ticketsByStage: Record<string, Ticket[]>;
} | null> {
  const project = await getProject(projectSlug);
  if (!project) return null;

  const workflowSlug = project.fields.default_workflow;
  let workflow = workflowSlug ? await getWorkflow(workflowSlug) : null;
  if (!workflow) {
    const workflows = await listWorkflowsForProject(projectSlug);
    workflow = workflows[0] ?? null;
  }

  const stages = parseStages(workflow?.fields.stages_json);
  const tickets = await listTicketsForProject(projectSlug);
  const ticketsByStage: Record<string, Ticket[]> = {};
  for (const stage of stages) {
    ticketsByStage[stage.key] = [];
  }
  for (const ticket of tickets) {
    const key = ticket.fields.stage;
    if (!ticketsByStage[key]) ticketsByStage[key] = [];
    ticketsByStage[key].push(ticket);
  }

  const last = lastStageKey(stages);
  if (last && ticketsByStage[last]) {
    ticketsByStage[last] = newestFirstCapped(
      ticketsByStage[last],
      (t) => t.fields.stage_entered_at,
    );
  }

  return { project, workflow, stages, ticketsByStage };
}

export async function searchProjectPublic(
  projectSlug: string,
  filters: {
    q?: string;
    type?: "all" | "ticket" | "wiki_page";
    stage?: string;
    resolution?: string;
    priority?: string;
    created_by?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{
  items: SearchHit[];
  total: number;
  limit: number;
  offset: number;
}> {
  const tickets = await listTicketsForProject(projectSlug);
  const [comments, wiki] = await Promise.all([
    listCommentsForTickets(tickets.map((t) => t.slug)),
    listWikiPagesForProject(projectSlug),
  ]);

  const commentsByTicket = new Map<string, Comment[]>();
  for (const comment of comments) {
    const key = relationSlug(comment.fields.ticket);
    if (!key) continue;
    const list = commentsByTicket.get(key) ?? [];
    list.push(comment);
    commentsByTicket.set(key, list);
  }

  const hits = searchProjectContent({
    tickets: tickets.map((t) => {
      const ticketComments = commentsByTicket.get(t.slug) ?? [];
      return {
        slug: t.slug,
        ticket_key: t.fields.ticket_key ?? null,
        title: t.fields.title,
        description: t.fields.description ?? "",
        stage: t.fields.stage,
        priority: t.fields.priority ?? "medium",
        created_by: t.fields.created_by ?? null,
        resolution: t.fields.resolution ?? null,
        stage_entered_at: t.fields.stage_entered_at ?? null,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        commentBodies: ticketComments.map((c) => c.fields.body),
        commentAuthors: ticketComments
          .map((c) => c.fields.author)
          .filter((a): a is string => Boolean(a)),
      };
    }),
    wikiPages: wiki.pages.map((p) => ({
      slug: p.slug,
      title: p.fields.title,
      body: p.fields.body ?? "",
      updatedAt: p.updatedAt,
    })),
    filters: {
      q: filters.q,
      type: filters.type ?? "all",
      stage: filters.stage,
      resolution: filters.resolution,
      priority: filters.priority,
      created_by: filters.created_by,
      from: filters.from,
      to: filters.to,
    },
  });

  return paginateItems(hits, filters.limit ?? 25, filters.offset ?? 0);
}

export async function listProjectHistoryPublic(
  projectSlug: string,
  options: {
    stage?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{
  items: Array<{
    slug: string;
    ticket_key: string | null;
    title: string;
    stage: string;
    priority: string;
    created_by: string | null;
    stage_entered_at: string | null;
    tokens_estimate: number | null;
    tokens_actual: number | null;
    resolution: string | null;
  }>;
  total: number;
  limit: number;
  offset: number;
}> {
  const tickets = await listTicketsForProject(projectSlug);
  const filtered = options.stage
    ? tickets.filter((t) => t.fields.stage === options.stage)
    : tickets;
  const sorted = sortTicketsNewestFirst(
    filtered.map((t) => ({
      slug: t.slug,
      ticket_key: t.fields.ticket_key ?? null,
      title: t.fields.title,
      stage: t.fields.stage,
      priority: t.fields.priority ?? "medium",
      created_by: t.fields.created_by ?? null,
      stage_entered_at: t.fields.stage_entered_at ?? null,
      tokens_estimate: t.fields.tokens_estimate ?? null,
      tokens_actual: t.fields.tokens_actual ?? null,
      resolution: t.fields.resolution ?? null,
    })),
  );
  return paginateItems(sorted, options.limit ?? 25, options.offset ?? 0);
}

export async function getProjectInsightsPublic(
  projectSlug: string,
): Promise<{ project: Project; insights: ProjectInsights } | null> {
  const board = await getProjectBoard(projectSlug);
  if (!board) return null;
  // Board caps Done for display; insights must use the uncapped ticket list.
  const tickets = await listTicketsForProject(projectSlug);
  const doneStage = lastStageKey(board.stages) ?? "done";
  const insights = computeProjectInsights(
    tickets.map((t) => ({
      slug: t.slug,
      ticket_key: t.fields.ticket_key ?? null,
      title: t.fields.title,
      stage: t.fields.stage,
      stage_entered_at: t.fields.stage_entered_at ?? null,
      tokens_estimate: t.fields.tokens_estimate ?? null,
      tokens_actual: t.fields.tokens_actual ?? null,
      resolution: t.fields.resolution ?? null,
    })),
    { doneStageKey: doneStage },
  );
  return { project: board.project, insights };
}

export type HomepageConnectStep = {
  title: string;
  body: string;
};

export type HomepageConnectContent = {
  eyebrow: string;
  heading: string;
  lede: string;
  steps: HomepageConnectStep[];
  tools: string[];
  toolsNote: string;
  rules: string[];
  mcpConfig: string;
  apiUrl: string;
};

type HomepageConnectFields = {
  eyebrow?: string | null;
  heading?: string | null;
  lede?: string | null;
  steps_json?: string | null;
  tools_json?: string | null;
  tools_note?: string | null;
  rules_json?: string | null;
  mcp_config?: string | null;
  api_url?: string | null;
  mcp_package_path?: string | null;
};

const HOMEPAGE_CONNECT_FALLBACK: HomepageConnectContent = {
  eyebrow: "For AI agents",
  heading: "Connect to TraceAI",
  lede: "TraceAI is an issue tracker built for agents (Cursor, Claude Code, and similar). Agents authenticate with a personal TraceAI API token (`trc_…`) only — never with CMS credentials. Humans sign in on the left with a TraceAI account to use boards, inbox, and settings.",
  steps: [
    {
      title: "Ensure the TraceAI API is reachable",
      body: "Production (required for agents / MCP):\nhttps://traceai.joostvanleeuwaarden.com\n\nPoint TRACEAI_API_URL at that URL. A local API is only for developing TraceAI itself — agents should still use production.",
    },
    {
      title: "Create a TraceAI API token",
      body: "Preferred (after you have a TraceAI web account):\n1. Sign in on the left.\n2. Open API-tokens in the header.\n3. Create a token (pick a name and optional expiry).\n4. Copy the printed trc_… value — shown only once.\n\nOperators / bootstrap without UI: from a TraceAI checkout, `pnpm --filter @traceai/api create-token -- --email <existing-user-email> --name cursor` (API user must already exist, e.g. via bootstrap).",
    },
    {
      title: "Register the TraceAI MCP server",
      body: "Add TraceAI to Cursor (~/.cursor/mcp.json) or Claude Code MCP config. Point args at packages/mcp/dist/index.js in your TraceAI checkout, set TRACEAI_API_URL to the production URL, and replace trc_YOUR_TOKEN with your token (see MCP config template below).",
    },
    {
      title: "Reload MCP and start",
      body: "Reload the TraceAI MCP server in the IDE, then call list_projects. Pick or create a project, read get_project / get_workflow for the agent playbook, then use tickets, transitions, wiki, and search as needed.",
    },
  ],
  tools: [
    "list_projects / get_project / create_project",
    "list_tickets / get_ticket / create_ticket / update_ticket (slug or TRA-n; optional parent)",
    "add_comment / transition_ticket (tokens_used / tokens_estimate / resolution when required)",
    "list_workflows / get_workflow / create_workflow / update_workflow",
    "list_wiki_pages / get_wiki_page / create_wiki_page / update_wiki_page",
    "search_project / list_project_history / get_project_insights",
  ],
  toolsNote:
    "Ticket created_by and comment author come from the TraceAI identity behind the API token. Prefer organizing work in projects with an explicit workflow before large implementation tasks.",
  rules: [
    "Agents use TRACEAI_TOKEN (trc_…) only — never put CMS credentials in the MCP env.",
    "Humans create personal API tokens after sign-in via API-tokens (header link).",
    "Call get_project / get_workflow first; the response includes agent_playbook / agent_policy (working agreements live in workflow JSON).",
    "Ticket descriptions must be self-contained Markdown for junior agents (Context, Goal, What to implement, Acceptance criteria).",
    "Every transition_ticket needs a comment with ## Vorige stap and ## Deze stap, plus tokens_used when the workflow requires it.",
    "Leaving Backlog / In Refinement may require tokens_estimate (see require_*_on_exit_to flags on the stage).",
    "Entering review also requires ## Testverslag and ## Uitslag (PASS/FAIL).",
    "Human-gated stages: a signed-in reviewer presses Goedkeuren/Afkeuren in the UI; the agent then performs the transition.",
    "Entering Done needs resolution (completed | superseded | cancelled | duplicate | verification-only) and ## Wiki with page slug(s) or N/A.",
    "All ticket/workflow/wiki writes go through TraceAI MCP or the TraceAI API — never bypass TraceAI.",
    "Humans can add light wish-tickets from a project board (New ticket) after signing in; they land in Backlog for agents to refine.",
    "Project boards are live via SSE from https://traceai.joostvanleeuwaarden.com/events?project=… — cards move without refreshing.",
    "Use the Inbox for tickets waiting on your human verdict.",
  ],
  mcpConfig: `{
  "mcpServers": {
    "traceai": {
      "command": "node",
      "args": ["<path-to-TraceAI>/packages/mcp/dist/index.js"],
      "env": {
        "TRACEAI_API_URL": "https://traceai.joostvanleeuwaarden.com",
        "TRACEAI_TOKEN": "trc_YOUR_TOKEN"
      }
    }
  }
}`,
  apiUrl: "https://traceai.joostvanleeuwaarden.com",
};

function parseJsonArray<T>(raw: string | null | undefined, fallback: T[]): T[] {
  if (!raw?.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

function parseHomepageConnectFields(
  fields: HomepageConnectFields | undefined,
): HomepageConnectContent {
  if (!fields) return HOMEPAGE_CONNECT_FALLBACK;

  const stepsRaw = parseJsonArray<HomepageConnectStep>(
    fields.steps_json,
    HOMEPAGE_CONNECT_FALLBACK.steps,
  );
  const steps = stepsRaw
    .filter(
      (s): s is HomepageConnectStep =>
        Boolean(s) &&
        typeof s === "object" &&
        typeof s.title === "string" &&
        typeof s.body === "string",
    )
    .map((s) => ({ title: s.title, body: s.body }));

  const tools = parseJsonArray<unknown>(
    fields.tools_json,
    HOMEPAGE_CONNECT_FALLBACK.tools,
  )
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    .map((t) => t.trim());

  const rules = parseJsonArray<unknown>(
    fields.rules_json,
    HOMEPAGE_CONNECT_FALLBACK.rules,
  )
    .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
    .map((r) => r.trim());

  return {
    eyebrow: fields.eyebrow?.trim() || HOMEPAGE_CONNECT_FALLBACK.eyebrow,
    heading: fields.heading?.trim() || HOMEPAGE_CONNECT_FALLBACK.heading,
    lede: fields.lede?.trim() || HOMEPAGE_CONNECT_FALLBACK.lede,
    steps: steps.length > 0 ? steps : HOMEPAGE_CONNECT_FALLBACK.steps,
    tools: tools.length > 0 ? tools : HOMEPAGE_CONNECT_FALLBACK.tools,
    toolsNote:
      fields.tools_note?.trim() || HOMEPAGE_CONNECT_FALLBACK.toolsNote,
    rules: rules.length > 0 ? rules : HOMEPAGE_CONNECT_FALLBACK.rules,
    mcpConfig:
      fields.mcp_config?.trim() || HOMEPAGE_CONNECT_FALLBACK.mcpConfig,
    apiUrl: fields.api_url?.trim() || HOMEPAGE_CONNECT_FALLBACK.apiUrl,
  };
}

/** Public homepage Connect section copy (CMS `homepage_connect`, slug `default`). */
export async function getHomepageConnect(): Promise<HomepageConnectContent> {
  try {
    if (!siteKey) return HOMEPAGE_CONNECT_FALLBACK;
    const client = getPublicClient();
    try {
      const entry = await client.getEntry<{ fields: HomepageConnectFields }>(
        "homepage_connect",
        "default",
      );
      return parseHomepageConnectFields(entry.fields);
    } catch {
      const listed = await client.listEntries<{ fields: HomepageConnectFields }>(
        "homepage_connect",
        { limit: 1 },
      );
      const first = listed.items[0];
      if (!first) return HOMEPAGE_CONNECT_FALLBACK;
      return parseHomepageConnectFields(first.fields);
    }
  } catch {
    return HOMEPAGE_CONNECT_FALLBACK;
  }
}
