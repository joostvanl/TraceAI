import {
  AuroraPublicClient,
  TraceApiClient,
  lastStageKey,
  newestFirstCapped,
  parseStages,
  type Comment,
  type Project,
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
  const result = await getPublicClient().listEntries<Comment>("comment", {
    limit: 100,
  });
  return result.items
    .filter((c) => c.fields.ticket === ticketSlug)
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
}

export type WikiTreeNode = {
  slug: string;
  title: string;
  parent: string | null;
  children: WikiTreeNode[];
};

export async function listWikiPagesForProject(projectSlug: string): Promise<{
  pages: WikiPage[];
  tree: WikiTreeNode[];
}> {
  const result = await getPublicClient().listEntries<WikiPage>("wiki_page", {
    limit: 100,
  });
  const pages = result.items
    .filter((p) => p.fields.project === projectSlug)
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
      parent: page.fields.parent || null,
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
