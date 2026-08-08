import {
  AuroraPublicClient,
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
