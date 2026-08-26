import {
  AURORA_FIELD_IN_MAX,
  AuroraApiError,
  AuroraManagementClient,
  type AuroraClientConfig,
  type FieldEdit,
  type FieldEditSummary,
  type ListEntriesQuery,
} from "./aurora.js";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  assertNoErrors,
} from "./trace-errors.js";
import { listAllEntries as listAllEntriesShared } from "./list-all-entries.js";
import {
  isProjectWorkflow,
  isTicketWorkflowReassignable,
  nextColumnSortOrder,
  workflowReassignAuditComment,
} from "./board-workflow.js";
import {
  assertNonNegativeIntegerSortOrder,
  planTicketReorder,
} from "./reorder.js";
import { STANDARD_WORKER_WORKFLOW_DOCUMENT } from "./standard-worker-workflow.js";
import { allocateUniqueEntrySlug } from "./unique-entry-slug.js";
import {
  resolveWikiEntrySlugInProject,
  wikiEntrySlug,
  wikiLogicalSlug,
} from "./wiki-slugs.js";
import { selectWikiPages, sortWikiPages } from "./wiki-pages.js";
import {
  DEFAULT_STAGES,
  DEFAULT_WORKFLOW_DOCUMENT,
  canTransition,
  deriveProjectKeyFromSlug,
  exitRequiresPlaybookDescription,
  exitRequiresTokensEstimate,
  firstStageKey,
  formatReviewVerdictComment,
  formatTicketKey,
  isTicketKeyPattern,
  normalizeProjectKey,
  parseWorkflowDocument,
  reviewVerdictTarget,
  serializeWorkflowDocument,
  slugify,
  validateHumanGateExit,
  validateReviewVerdict,
  validateTicketDescription,
  validateTransitionComment,
  validateTransitionResolution,
  validateTransitionTokens,
  CLEARED_REVIEW_FIELDS,
  type TicketResolution,
  type TicketReviewState,
  APP_LOGIN_CONTENT_TYPE,
  APP_LOGIN_ENTRY_SLUG,
  TRACEAI_USER_CONTENT_TYPE,
  PROJECT_MEMBERSHIP_CONTENT_TYPE,
  WIKI_PAGE_CONTENT_TYPE,
  type AppLogin,
  type Comment,
  type Priority,
  type Project,
  type ProjectMembership,
  type Ticket,
  type TraceaiUser,
  type UiIdentity,
  type WikiPage,
  type Workflow,
  type WorkflowAgentPolicy,
  type WorkflowDocument,
  type WorkflowStage,
  lastStageKey,
} from "./types.js";
import { enforceExpectedTransition } from "./stage-conflict.js";
import { assertHumanGateTransition } from "./human-gate-open.js";
import {
  computeTokenRollup,
  listChildTickets,
  listDescendantSlugs,
  validateTicketParent,
} from "./ticket-links.js";
import {
  isProjectRole,
  membershipSlug,
  roleAtLeast,
  wouldRemoveLastPlatformAdmin,
  type ProjectRole,
} from "./roles.js";
import { relationSlug, relationSlugOrEmpty } from "./relations.js";
import {
  claimPersistenceFields,
  parseClaimedAgentId,
} from "./claimed-agent.js";
import {
  buildReviewInboxItems,
  type ReviewInboxItem,
} from "./review-inbox.js";
import {
  computeEstimateVsActual,
  computeProjectInsights,
  paginateItems,
  sortTicketsNewestFirst,
  type EstimateVsActualResult,
  type Paginated,
  type ProjectInsights,
} from "./insights.js";
import {
  ProjectIndexLruCache,
  ProjectSearchIndex,
  SEARCH_PROFILE_DEFAULTS,
  type SearchFilters,
  type SearchHit,
  type SearchMeta,
  type SearchProfile,
  type SearchTicketInput,
  type SearchWikiInput,
} from "./search-index.js";
import {
  applyTicketTemplate,
  canvasToPendingDraft,
  computeMigrationImpact,
  documentToCanvas,
  effectiveEditableDocument,
  summarizeWorkflowBehaviour,
  validateMigrationMap,
  validateWorkflowDocument,
  WorkflowValidationError,
  type ApplyTemplateMode,
  type StageMigrationMap,
  type TicketTemplate,
  type WorkflowCanvasModel,
  type WorkflowMigrationImpact,
} from "./workflow-editor.js";

export { WorkflowValidationError } from "./workflow-editor.js";

export type TraceServiceOptions = AuroraClientConfig & {
  websiteId?: string;
  searchIndexTtlMs?: number;
  searchIndexMaxProjects?: number;
  now?: () => number;
};

function uniqueSlug(base: string, existing: Set<string>): string {
  let candidate = slugify(base);
  if (!existing.has(candidate)) return candidate;
  let i = 2;
  while (existing.has(`${candidate}-${i}`)) i += 1;
  return `${candidate}-${i}`;
}

function resolveProjectKey(project: Project): string {
  return (
    normalizeProjectKey(project.fields.project_key) ??
    deriveProjectKeyFromSlug(project.slug)
  );
}

export class TraceService {
  readonly client: AuroraManagementClient;
  private readonly websiteId?: string;
  private readonly now: () => number;
  private readonly searchIndexes: ProjectIndexLruCache<ProjectSearchIndex>;
  private readonly searchIndexBuilds = new Map<
    string,
    Promise<ProjectSearchIndex>
  >();
  private ready: Promise<void> | null = null;

  constructor(options: TraceServiceOptions) {
    this.client = new AuroraManagementClient(options);
    this.websiteId = options.websiteId;
    this.now = options.now ?? Date.now;
    this.searchIndexes = new ProjectIndexLruCache(
      options.searchIndexTtlMs ?? 300_000,
      options.searchIndexMaxProjects ?? 2,
      this.now,
    );
  }

  async ensureReady() {
    if (!this.ready) {
      this.ready = (async () => {
        if (this.websiteId && this.client.token.startsWith("aur_u_")) {
          await this.client.selectWebsite(this.websiteId);
        }
      })();
    }
    await this.ready;
  }

  /**
   * Page through all entries of a content type. Thin wrapper around the shared
   * {@link listAllEntriesShared} helper (Aurora caps `limit` at 100).
   */
  private async listAllEntries<T>(
    apiId: string,
    query: Pick<ListEntriesQuery, "status" | "field" | "in" | "sort" | "order"> = {},
  ): Promise<T[]> {
    return listAllEntriesShared(this.client, apiId, query);
  }

  /**
   * Load comments whose `ticket` field matches any of the given ticket slugs.
   * Uses Aurora `field`/`in` (chunked at 50) instead of scanning every comment.
   */
  private async listCommentsForTickets(
    ticketSlugs: readonly string[],
    query: { status?: string } = { status: "published" },
  ): Promise<Comment[]> {
    const unique = [
      ...new Set(
        ticketSlugs
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    if (unique.length === 0) return [];
    const out: Comment[] = [];
    for (let i = 0; i < unique.length; i += AURORA_FIELD_IN_MAX) {
      const chunk = unique.slice(i, i + AURORA_FIELD_IN_MAX);
      const items = await this.listAllEntries<Comment>("comment", {
        ...query,
        field: "ticket",
        in: chunk,
      });
      out.push(...items);
    }
    return out;
  }

  private ticketSearchInput(
    ticket: Ticket,
    comments: readonly Comment[] = [],
  ): SearchTicketInput {
    return {
      slug: ticket.slug,
      ticket_key: ticket.fields.ticket_key ?? null,
      title: ticket.fields.title,
      description: ticket.fields.description ?? "",
      stage: ticket.fields.stage,
      priority: ticket.fields.priority ?? "medium",
      created_by: ticket.fields.created_by ?? null,
      resolution: ticket.fields.resolution ?? null,
      stage_entered_at: ticket.fields.stage_entered_at ?? null,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      commentBodies: comments.map((comment) => comment.fields.body),
      commentAuthors: comments
        .map((comment) => comment.fields.author)
        .filter((author): author is string => Boolean(author)),
    };
  }

  private wikiSearchInput(page: WikiPage): SearchWikiInput {
    return {
      slug: page.slug,
      title: page.fields.title,
      body: page.fields.body ?? "",
      updatedAt: page.updatedAt,
    };
  }

  private invalidateSearchIndex(project: string): void {
    this.searchIndexes.delete(project);
    this.searchIndexBuilds.delete(project);
  }

  private async buildSearchIndex(
    project: string,
  ): Promise<ProjectSearchIndex> {
    const tickets = await this.listTickets({ project });
    const [comments, wikiPages] = await Promise.all([
      this.listCommentsForTickets(tickets.map((ticket) => ticket.slug)),
      this.loadProjectWikiPages(project),
    ]);
    const commentsByTicket = new Map<string, Comment[]>();
    for (const comment of comments) {
      const ticketSlug = relationSlug(comment.fields.ticket);
      if (!ticketSlug) continue;
      const grouped = commentsByTicket.get(ticketSlug) ?? [];
      grouped.push(comment);
      commentsByTicket.set(ticketSlug, grouped);
    }
    return new ProjectSearchIndex(
      tickets.map((ticket) =>
        this.ticketSearchInput(ticket, commentsByTicket.get(ticket.slug)),
      ),
      wikiPages.map((page) => this.wikiSearchInput(page)),
    );
  }

  private async getSearchIndex(project: string): Promise<ProjectSearchIndex> {
    const cached = this.searchIndexes.get(project);
    if (cached) return cached.value;

    let building = this.searchIndexBuilds.get(project);
    if (!building) {
      building = this.buildSearchIndex(project);
      this.searchIndexBuilds.set(project, building);
    }
    try {
      const built = await building;
      this.searchIndexes.set(project, built);
      return built;
    } finally {
      this.searchIndexBuilds.delete(project);
    }
  }

  private async upsertSearchTicket(ticket: Ticket): Promise<void> {
    const project = relationSlug(ticket.fields.project);
    if (!project) return;
    const cached = this.searchIndexes.get(project);
    if (!cached) return;
    const comments = await this.listCommentsForTickets([ticket.slug]);
    cached.value.upsertTicket(this.ticketSearchInput(ticket, comments));
  }

  private upsertSearchWikiPage(page: WikiPage): void {
    const project = relationSlug(page.fields.project);
    if (!project) return;
    const cached = this.searchIndexes.get(project);
    if (!cached) return;
    cached.value.upsertWikiPage(this.wikiSearchInput(page));
  }

  async listProjects(): Promise<Project[]> {
    await this.ensureReady();
    return this.listAllEntries<Project>("project", { status: "published" });
  }

  async getProject(slug: string): Promise<{
    project: Project;
    workflow: Workflow | null;
    stages: WorkflowStage[];
    workflow_document: WorkflowDocument | null;
  } | null> {
    await this.ensureReady();
    const project = await this.client.getEntryBySlug<Project>("project", slug);
    if (!project) return null;
    const workflowSlug = relationSlug(project.fields.default_workflow);
    const workflow = workflowSlug
      ? await this.client.getEntryBySlug<Workflow>("workflow", workflowSlug)
      : (await this.listWorkflows(slug))[0] ?? null;
    const workflow_document = workflow
      ? parseWorkflowDocument(workflow.fields.stages_json)
      : null;
    return {
      project,
      workflow,
      stages: workflow_document?.stages ?? [],
      workflow_document,
    };
  }

  async createProject(input: {
    name: string;
    description?: string;
    slug?: string;
    seedWorkflow?: boolean;
    seedWiki?: boolean;
    ownerUser?: string;
  }): Promise<{
    project: Project;
    workflow: Workflow | null;
    wiki_pages: WikiPage[];
  }> {
    await this.ensureReady();
    const ownerUser = input.ownerUser?.trim() || undefined;
    if (ownerUser) {
      const user = await this.getTraceaiUser(ownerUser);
      if (!user) throw new NotFoundError(`User not found: ${ownerUser}`);
    }

    const slug = await allocateUniqueEntrySlug(
      this.client,
      "project",
      input.slug ?? input.name,
    );

    // Create project first so workflow.project relation resolves.
    let project = await this.client.createEntry<Project>("project", {
      slug,
      status: "published",
      fields: {
        name: input.name,
        description: input.description ?? "",
        project_key: deriveProjectKeyFromSlug(slug),
        next_ticket_number: 1,
      },
    });
    await this.ensurePublished("project", project);

    let workflow: Workflow | null = null;
    if (input.seedWorkflow !== false) {
      const workflowSlug = `${slug}-standard-worker`;
      workflow = await this.client.createEntry<Workflow>("workflow", {
        slug: workflowSlug,
        status: "published",
        fields: {
          name: "Standard Worker",
          project: slug,
          stages_json: serializeWorkflowDocument(
            STANDARD_WORKER_WORKFLOW_DOCUMENT,
          ),
        },
      });
      await this.ensurePublished("workflow", workflow);
      project = await this.client.updateEntry<Project>("project", project.id, {
        fields: { default_workflow: workflow.slug },
      });
      await this.ensurePublished("project", project);
    }

    if (ownerUser) {
      await this.setProjectMembership({
        project: slug,
        user: ownerUser,
        role: "admin",
      });
    }

    let wiki_pages: WikiPage[] = [];
    if (input.seedWiki !== false) {
      wiki_pages = await this.seedProjectHandbookWiki(slug);
    }

    return { project, workflow, wiki_pages };
  }

  /** Seed handbook root pages (Home … Design packs) for a new project. */
  async seedProjectHandbookWiki(projectSlug: string): Promise<WikiPage[]> {
    const seeds: Array<{ logical: string; title: string; body: string }> = [
      {
        logical: "home",
        title: "Home",
        body: `# Home\n\nWelcome to this TraceAI project handbook.\n\nStart with [Getting started](getting-started).\n`,
      },
      {
        logical: "getting-started",
        title: "Getting started",
        body: `# Getting started\n\nHow to run agents and open the board for this project.\n`,
      },
      {
        logical: "architecture",
        title: "Architecture",
        body: `# Architecture\n\nSystem overview and key technical decisions for this project.\n`,
      },
      {
        logical: "product",
        title: "Product & process",
        body: `# Product & process\n\nProduct intent and how work moves through the workflow.\n`,
      },
      {
        logical: "engineering",
        title: "Engineering",
        body: `# Engineering\n\nEngineering conventions and implementation notes.\n`,
      },
      {
        logical: "operations",
        title: "Operations",
        body: `# Operations\n\nDeploy, monitor, and operate this project.\n`,
      },
      {
        logical: "design-packs",
        title: "Design packs",
        body: `# Design packs\n\nParent index for per-ticket design packs. Keep detailed FO/TO/use cases/tests under children of this page.\n`,
      },
    ];

    const pages: WikiPage[] = [];
    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i]!;
      pages.push(
        await this.createWikiPage({
          project: projectSlug,
          title: seed.title,
          body: seed.body,
          slug: seed.logical,
          sort_order: i,
          updated_by: "system",
        }),
      );
    }
    return pages;
  }

  async listWorkflows(projectSlug?: string): Promise<Workflow[]> {
    await this.ensureReady();
    if (!projectSlug) {
      return this.listAllEntries<Workflow>("workflow", { status: "published" });
    }
    const matches = (items: Workflow[]) =>
      items.filter((w) => relationSlug(w.fields.project) === projectSlug);
    const scoped = matches(
      await this.listAllEntries<Workflow>("workflow", {
        status: "published",
        field: "project",
        in: [projectSlug],
      }),
    );
    if (scoped.length > 0) return scoped;
    // Relation fields may be stored as objects; empty scoped result is
    // indistinguishable from "no workflows", so confirm with a full scan.
    return matches(
      await this.listAllEntries<Workflow>("workflow", { status: "published" }),
    );
  }

  async getWorkflow(slug: string): Promise<{
    workflow: Workflow;
    stages: WorkflowStage[];
    workflow_document: WorkflowDocument;
  } | null> {
    await this.ensureReady();
    const workflow = await this.client.getEntryBySlug<Workflow>("workflow", slug);
    if (!workflow) return null;
    const workflow_document = parseWorkflowDocument(workflow.fields.stages_json);
    return {
      workflow,
      stages: workflow_document.stages,
      workflow_document,
    };
  }

  async createWorkflow(input: {
    name: string;
    project: string;
    stages?: WorkflowStage[];
    document?: WorkflowDocument;
    slug?: string;
  }): Promise<Workflow> {
    await this.ensureReady();
    const slug = await allocateUniqueEntrySlug(
      this.client,
      "workflow",
      input.slug ?? `${input.project}-${input.name}`,
    );
    const document =
      input.document ??
      ({
        ...DEFAULT_WORKFLOW_DOCUMENT,
        stages: input.stages ?? DEFAULT_STAGES,
      } satisfies WorkflowDocument);
    const workflow = await this.client.createEntry<Workflow>("workflow", {
      slug,
      status: "published",
      fields: {
        name: input.name,
        project: input.project,
        stages_json: serializeWorkflowDocument(document),
      },
    });
    await this.ensurePublished("workflow", workflow);
    return workflow;
  }

  async setProjectDefaultWorkflow(
    projectSlug: string,
    workflowSlug: string,
  ): Promise<Project> {
    await this.ensureReady();
    const result = await this.getProject(projectSlug);
    if (!result) throw new NotFoundError(`Project not found: ${projectSlug}`);
    const owned = await this.listWorkflows(projectSlug);
    const currentDefault = relationSlug(result.project.fields.default_workflow);
    if (
      !isProjectWorkflow(
        workflowSlug,
        currentDefault,
        owned.map((workflow) => workflow.slug),
      )
    ) {
      throw new ValidationError(
        `Workflow "${workflowSlug}" is not a workflow of project ${projectSlug}`,
      );
    }
    return this.client.updateEntry<Project>("project", result.project.id, {
      fields: { default_workflow: workflowSlug },
    });
  }

  async cloneWorkflow(input: {
    source: string;
    project: string;
  }): Promise<Workflow> {
    await this.ensureReady();
    const dest = await this.getProject(input.project);
    if (!dest) throw new NotFoundError(`Project not found: ${input.project}`);
    const source = await this.getWorkflow(input.source);
    if (!source) throw new NotFoundError(`Workflow not found: ${input.source}`);
    const document = JSON.parse(
      JSON.stringify(source.workflow_document),
    ) as WorkflowDocument;
    const destList = await this.listWorkflows(input.project);
    const sourceName = source.workflow.fields.name;
    const nameTaken = destList.some(
      (workflow) => workflow.fields.name === sourceName,
    );
    return this.createWorkflow({
      name: nameTaken ? `${sourceName} (kopie)` : sourceName,
      project: input.project,
      document,
      slug: `${input.project}-${source.workflow.slug}`,
    });
  }

  async updateWorkflow(
    slug: string,
    input: {
      name?: string;
      stages?: WorkflowStage[];
      document?: WorkflowDocument;
      agent_policy?: WorkflowAgentPolicy;
    },
  ): Promise<Workflow> {
    await this.ensureReady();
    const workflow = await this.client.getEntryBySlug<Workflow>("workflow", slug);
    if (!workflow) throw new NotFoundError(`Workflow not found: ${slug}`);
    const current = parseWorkflowDocument(workflow.fields.stages_json);
    let nextDoc: WorkflowDocument | null = null;
    if (input.document) {
      nextDoc = {
        version: input.document.version ?? current.version ?? 2,
        agent_policy: input.document.agent_policy ?? current.agent_policy,
        stages: input.document.stages?.length
          ? input.document.stages
          : current.stages,
        editor_layout:
          input.document.editor_layout !== undefined
            ? input.document.editor_layout
            : current.editor_layout,
        ticket_templates:
          input.document.ticket_templates !== undefined
            ? input.document.ticket_templates
            : current.ticket_templates,
        pending:
          input.document.pending !== undefined
            ? input.document.pending
            : current.pending,
      };
    } else if (input.stages || input.agent_policy) {
      nextDoc = {
        version: 2,
        agent_policy: input.agent_policy ?? current.agent_policy,
        stages: input.stages ?? current.stages,
        editor_layout: current.editor_layout,
        ticket_templates: current.ticket_templates,
        pending: current.pending,
      };
    }
    if (nextDoc) {
      const issues = validateWorkflowDocument({
        stages: nextDoc.pending?.stages ?? nextDoc.stages,
        agent_policy: nextDoc.pending?.agent_policy ?? nextDoc.agent_policy,
      });
      // Direct live updates must be valid; pending drafts are validated on saveDraft/activate.
      if (!nextDoc.pending && issues.length) {
        throw new WorkflowValidationError(issues);
      }
    }
    const updated = await this.client.updateEntry<Workflow>("workflow", workflow.id, {
      fields: {
        ...(input.name != null ? { name: input.name } : {}),
        ...(nextDoc
          ? { stages_json: serializeWorkflowDocument(nextDoc) }
          : {}),
      },
    });
    await this.ensurePublished("workflow", updated);
    return updated;
  }

  /**
   * Save a visual-editor draft into `pending` without changing live stages.
   * Creates an Aurora entry version checkpoint of the current entry first.
   */
  async saveWorkflowDraft(
    slug: string,
    input: {
      canvas?: WorkflowCanvasModel;
      pending?: {
        agent_policy: WorkflowAgentPolicy;
        stages: WorkflowStage[];
        editor_layout?: WorkflowDocument["editor_layout"];
        ticket_templates?: TicketTemplate[];
      };
      saved_by?: string;
      name?: string;
    },
  ): Promise<{
    workflow: Workflow;
    workflow_document: WorkflowDocument;
    aurora_version_id: string | null;
  }> {
    await this.ensureReady();
    const workflow = await this.client.getEntryBySlug<Workflow>("workflow", slug);
    if (!workflow) throw new NotFoundError(`Workflow not found: ${slug}`);
    const current = parseWorkflowDocument(workflow.fields.stages_json);
    const pending = input.pending
      ? {
          ...input.pending,
          saved_at: new Date().toISOString(),
          saved_by: input.saved_by,
        }
      : canvasToPendingDraft(
          input.canvas ?? documentToCanvas(current),
          { saved_by: input.saved_by },
        );
    const issues = validateWorkflowDocument(pending);
    if (issues.length) throw new WorkflowValidationError(issues);

    let aurora_version_id: string | null = null;
    try {
      const version = await this.client.createEntryVersion("workflow", workflow.id, {
        label: `draft-save ${new Date().toISOString()}`,
      });
      aurora_version_id = version.id;
    } catch {
      // Aurora versions are best-effort; draft save still proceeds.
      aurora_version_id = null;
    }

    const nextDoc: WorkflowDocument = {
      ...current,
      version: Math.max(current.version || 2, 3),
      pending,
      editor_layout: pending.editor_layout ?? current.editor_layout,
      ticket_templates: pending.ticket_templates ?? current.ticket_templates,
    };
    const updated = await this.client.updateEntry<Workflow>("workflow", workflow.id, {
      fields: {
        ...(input.name != null ? { name: input.name } : {}),
        stages_json: serializeWorkflowDocument(nextDoc),
      },
    });
    await this.ensurePublished("workflow", updated);
    return {
      workflow: updated,
      workflow_document: parseWorkflowDocument(updated.fields.stages_json),
      aurora_version_id,
    };
  }

  async previewWorkflowActivation(slug: string): Promise<{
    workflow_document: WorkflowDocument;
    impact: WorkflowMigrationImpact;
    validation_issues: ReturnType<typeof validateWorkflowDocument>;
    behaviour_summary: string;
  }> {
    await this.ensureReady();
    const result = await this.getWorkflow(slug);
    if (!result) throw new NotFoundError(`Workflow not found: ${slug}`);
    const doc = result.workflow_document;
    const editable = effectiveEditableDocument(doc);
    const tickets = await this.listTickets({
      project: result.workflow.fields.project,
    });
    const hits = tickets
      .filter((t) => t.fields.workflow === result.workflow.slug)
      .map((t) => ({
        slug: t.slug,
        ticket_key: t.fields.ticket_key ?? null,
        title: t.fields.title,
        stage: t.fields.stage,
      }));
    const impact = computeMigrationImpact(doc.stages, editable.stages, hits);
    const validation_issues = validateWorkflowDocument(editable);
    return {
      workflow_document: doc,
      impact,
      validation_issues,
      behaviour_summary: summarizeWorkflowBehaviour(editable),
    };
  }

  /**
   * Promote pending draft to live stages. Requires migration map when tickets
   * sit on removed stages. Creates an Aurora version checkpoint before apply.
   */
  async activateWorkflow(
    slug: string,
    input: {
      migration?: StageMigrationMap;
      activated_by?: string;
    } = {},
  ): Promise<{
    workflow: Workflow;
    workflow_document: WorkflowDocument;
    migrated_tickets: number;
    aurora_version_id: string | null;
  }> {
    await this.ensureReady();
    const workflow = await this.client.getEntryBySlug<Workflow>("workflow", slug);
    if (!workflow) throw new NotFoundError(`Workflow not found: ${slug}`);
    const current = parseWorkflowDocument(workflow.fields.stages_json);
    const editable = effectiveEditableDocument(current);
    const issues = validateWorkflowDocument(editable);
    if (issues.length) throw new WorkflowValidationError(issues);

    const tickets = await this.listTickets({
      project: workflow.fields.project,
    });
    const workflowTickets = tickets.filter(
      (t) => t.fields.workflow === workflow.slug,
    );
    const hits = workflowTickets.map((t) => ({
      slug: t.slug,
      ticket_key: t.fields.ticket_key ?? null,
      title: t.fields.title,
      stage: t.fields.stage,
    }));
    const impact = computeMigrationImpact(current.stages, editable.stages, hits);
    const migration = input.migration ?? {};
    const migrationIssues = validateMigrationMap(
      impact,
      migration,
      editable.stages.map((s) => s.key),
    );
    if (migrationIssues.length) {
      throw new WorkflowValidationError(migrationIssues);
    }

    let aurora_version_id: string | null = null;
    try {
      const version = await this.client.createEntryVersion("workflow", workflow.id, {
        label: `pre-activate ${new Date().toISOString()}`,
      });
      aurora_version_id = version.id;
    } catch {
      aurora_version_id = null;
    }

    let migrated_tickets = 0;
    for (const [fromStage, toStage] of Object.entries(migration)) {
      const moving = workflowTickets.filter((t) => t.fields.stage === fromStage);
      for (const ticket of moving) {
        await this.client.updateEntry<Ticket>("ticket", ticket.id, {
          fields: {
            stage: toStage,
            stage_entered_at: new Date().toISOString(),
            ...CLEARED_REVIEW_FIELDS,
          },
        });
        await this.ensurePublished("ticket", ticket);
        migrated_tickets += 1;
      }
    }

    const nextDoc: WorkflowDocument = {
      version: Math.max(current.version || 2, 3),
      agent_policy: editable.agent_policy,
      stages: editable.stages,
      editor_layout: editable.editor_layout,
      ticket_templates: editable.ticket_templates,
      pending: null,
    };
    const updated = await this.client.updateEntry<Workflow>("workflow", workflow.id, {
      fields: {
        stages_json: serializeWorkflowDocument(nextDoc),
      },
    });
    await this.ensurePublished("workflow", updated);
    if (migrated_tickets > 0) {
      const projectSlug = relationSlug(workflow.fields.project);
      if (projectSlug) this.invalidateSearchIndex(projectSlug);
    }
    return {
      workflow: updated,
      workflow_document: parseWorkflowDocument(updated.fields.stages_json),
      migrated_tickets,
      aurora_version_id,
    };
  }

  async listWorkflowVersions(slug: string) {
    await this.ensureReady();
    const workflow = await this.client.getEntryBySlug<Workflow>("workflow", slug);
    if (!workflow) throw new NotFoundError(`Workflow not found: ${slug}`);
    return this.client.listEntryVersions("workflow", workflow.id);
  }

  async restoreWorkflowVersion(slug: string, versionId: string) {
    await this.ensureReady();
    const workflow = await this.client.getEntryBySlug<Workflow>("workflow", slug);
    if (!workflow) throw new NotFoundError(`Workflow not found: ${slug}`);
    // Snapshot current before restore (Aurora also snapshots on restore).
    try {
      await this.client.createEntryVersion("workflow", workflow.id, {
        label: `pre-restore ${new Date().toISOString()}`,
      });
    } catch {
      // ignore
    }
    const restored = await this.client.restoreEntryVersion(
      "workflow",
      workflow.id,
      versionId,
    );
    const entry = restored.entry as Workflow;
    await this.ensurePublished("workflow", entry);
    return {
      workflow: entry,
      workflow_document: parseWorkflowDocument(entry.fields.stages_json),
      restored_from: restored.restoredFrom,
    };
  }

  applyWorkflowTicketTemplate(
    template: TicketTemplate,
    current: { title?: string; description?: string; priority?: Priority | string },
    options: { mode: ApplyTemplateMode; confirmed?: boolean },
  ) {
    return applyTicketTemplate(template, current, options);
  }

  async getWorkflowTemplates(slug: string): Promise<TicketTemplate[]> {
    const result = await this.getWorkflow(slug);
    if (!result) throw new NotFoundError(`Workflow not found: ${slug}`);
    const editable = effectiveEditableDocument(result.workflow_document);
    return editable.ticket_templates ?? [];
  }

  async listTickets(input: {
    project: string;
    stage?: string;
    parent?: string | null;
    /** Exact pin match; omit to return the full project set. */
    workflow?: string;
  }): Promise<Ticket[]> {
    await this.ensureReady();
    // Fall back on the *project* filter only. Deciding it after the stage and
    // parent filters would rescan every ticket whenever a query legitimately
    // matches nothing — an empty column is not a failed server-side filter.
    const inProject = (raw: Ticket[]) =>
      raw
        .map((t) => this.normalizeTicketRelations(t))
        .filter((t) => t.fields.project === input.project);

    let tickets = inProject(
      await this.listAllEntries<Ticket>("ticket", {
        status: "published",
        field: "project",
        in: [input.project],
      }),
    );
    if (tickets.length === 0) {
      tickets = inProject(
        await this.listAllEntries<Ticket>("ticket", { status: "published" }),
      );
    }

    return tickets
      .filter((t) => (input.stage ? t.fields.stage === input.stage : true))
      .filter((t) => {
        if (input.parent === undefined) return true;
        const parent = t.fields.parent || null;
        if (input.parent === null || input.parent === "") {
          return parent == null || parent === "";
        }
        return parent === input.parent;
      })
      .filter((t) =>
        input.workflow ? t.fields.workflow === input.workflow : true,
      )
      .sort((a, b) => (a.fields.sort_order ?? 0) - (b.fields.sort_order ?? 0));
  }

  /**
   * Personal review inbox for a human: gated tickets across projects the user
   * can access (membership editor+ not required here — callers filter; this
   * returns all gated tickets for the given project set).
   */
  async listReviewInbox(projectSlugs: string[]): Promise<ReviewInboxItem[]> {
    await this.ensureReady();
    const items: ReviewInboxItem[] = [];
    for (const projectSlug of projectSlugs) {
      const project = await this.getProject(projectSlug);
      if (!project) continue;
      const stages = project.stages;
      const tickets = await this.listTickets({ project: projectSlug });
      items.push(...buildReviewInboxItems(tickets, stages, projectSlug));
    }
    return items.sort((a, b) => {
      const aAt = a.ticket.fields.stage_entered_at ?? "";
      const bAt = b.ticket.fields.stage_entered_at ?? "";
      return bAt.localeCompare(aAt);
    });
  }

  /** Active project members with role >= editor (notification recipients). */
  async listReviewNotificationRecipients(
    projectSlug: string,
  ): Promise<string[]> {
    const memberships = await this.listProjectMemberships(projectSlug);
    const recipients: string[] = [];
    for (const m of memberships) {
      if (!roleAtLeast(isProjectRole(m.fields.role) ? m.fields.role : null, "editor")) {
        continue;
      }
      const user = await this.getTraceaiUser(m.fields.user);
      if (!user || user.fields.status !== "active") continue;
      recipients.push(user.slug);
    }
    // Platform admins always hear about gates even without membership.
    for (const user of await this.listTraceaiUsers()) {
      if (
        user.fields.is_platform_admin === true &&
        user.fields.status === "active" &&
        !recipients.includes(user.slug)
      ) {
        recipients.push(user.slug);
      }
    }
    return recipients;
  }

  /**
   * Full ticket history for a project (no board Done display cap).
   * Newest-first by stage_entered_at; paginated via limit/offset.
   */
  async listTicketHistory(input: {
    project: string;
    stage?: string;
    limit?: number;
    offset?: number;
  }): Promise<
    Paginated<{
      ticket: Ticket;
    }>
  > {
    const tickets = await this.listTickets({
      project: input.project,
      stage: input.stage,
    });
    const sorted = sortTicketsNewestFirst(
      tickets.map((ticket) => ({
        ticket,
        slug: ticket.slug,
        ticket_key: ticket.fields.ticket_key ?? null,
        title: ticket.fields.title,
        stage: ticket.fields.stage,
        stage_entered_at: ticket.fields.stage_entered_at ?? null,
      })),
    );
    const page = paginateItems(sorted, input.limit ?? 25, input.offset ?? 0);
    return {
      items: page.items.map((row) => ({ ticket: row.ticket })),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    };
  }

  async searchProject(input: {
    project: string;
    filters?: SearchFilters;
    includeWiki?: boolean;
    profile?: SearchProfile;
    includePreview?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<Paginated<SearchHit> & { meta: SearchMeta }> {
    await this.ensureReady();
    const project = await this.client.getEntryBySlug<Project>(
      "project",
      input.project,
    );
    if (!project) throw new NotFoundError(`Project not found: ${input.project}`);

    const index = await this.getSearchIndex(input.project);
    const filters = {
      ...input.filters,
      ...(input.includeWiki === false ? { type: "ticket" as const } : {}),
    };
    const result = index.search(filters, {
      profile: input.profile,
      includePreview: input.includePreview,
    });
    const profile = input.profile ?? "balanced";
    const page = paginateItems(
      result.hits,
      input.limit ?? SEARCH_PROFILE_DEFAULTS[profile].limit,
      input.offset ?? 0,
    );
    return { ...page, meta: result.meta };
  }

  async getProjectInsights(projectSlug: string): Promise<ProjectInsights> {
    const detail = await this.getProject(projectSlug);
    if (!detail) throw new NotFoundError(`Project not found: ${projectSlug}`);
    const tickets = await this.listTickets({ project: projectSlug });
    const doneStage = lastStageKey(detail.stages) ?? "done";
    return computeProjectInsights(
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
  }

  async getEstimateVsActual(
    projectSlug: string,
    options?: { limit?: number; breakpoints?: number[] },
  ): Promise<EstimateVsActualResult> {
    const detail = await this.getProject(projectSlug);
    if (!detail) throw new NotFoundError(`Project not found: ${projectSlug}`);
    const tickets = await this.listTickets({ project: projectSlug });
    const doneStage = lastStageKey(detail.stages) ?? "done";
    return computeEstimateVsActual(
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
      {
        doneStageKey: doneStage,
        limit: options?.limit,
        breakpoints: options?.breakpoints,
      },
    );
  }

  async getTicket(slugOrKey: string): Promise<{
    ticket: Ticket;
    comments: Comment[];
    children: Ticket[];
    tokens_estimate_rollup: number;
    tokens_actual_rollup: number;
    parent_ticket: Ticket | null;
  } | null> {
    await this.ensureReady();
    let ticket = await this.client.getEntryBySlug<Ticket>("ticket", slugOrKey);
    if (!ticket && isTicketKeyPattern(slugOrKey)) {
      const want = slugOrKey.trim().toUpperCase();
      const all = await this.listAllEntries<Ticket>("ticket", {
        status: "published",
      });
      ticket =
        all.find(
          (t) => (t.fields.ticket_key ?? "").toUpperCase() === want,
        ) ?? null;
    }
    if (!ticket) return null;
    ticket = this.normalizeTicketRelations(ticket);
    const projectTickets = await this.listTickets({
      project: ticket.fields.project,
    });
    const comments = (
      await this.listCommentsForTickets([ticket.slug])
    ).sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const childSlugs = new Set(
      listChildTickets(projectTickets, ticket.slug).map((c) => c.slug),
    );
    const children = projectTickets.filter((t) => childSlugs.has(t.slug));
    const rollup = computeTokenRollup(projectTickets, ticket.slug);
    const parentSlug = ticket.fields.parent || null;
    const parent_ticket = parentSlug
      ? (projectTickets.find((t) => t.slug === parentSlug) ?? null)
      : null;
    return {
      ticket,
      comments,
      children,
      parent_ticket,
      tokens_estimate_rollup: rollup.tokens_estimate_rollup,
      tokens_actual_rollup: rollup.tokens_actual_rollup,
    };
  }

  /**
   * Reserve the next ticket number for a project. Updates the project counter
   * before returning so concurrent creates are unlikely to collide; skips
   * numbers already present on tickets (backfill / race safety).
   */
  private async allocateTicketIdentity(
    projectSlug: string,
  ): Promise<{ projectKey: string; ticketNumber: number; ticketKey: string }> {
    const used = new Set(
      (await this.listTickets({ project: projectSlug }))
        .map((t) => Number(t.fields.ticket_number))
        .filter((n) => Number.isFinite(n) && n > 0),
    );

    for (let attempt = 0; attempt < 12; attempt++) {
      const project = await this.client.getEntryBySlug<Project>(
        "project",
        projectSlug,
      );
      if (!project) throw new NotFoundError(`Project not found: ${projectSlug}`);

      const projectKey = resolveProjectKey(project);
      let candidate = Math.max(
        1,
        Number(project.fields.next_ticket_number) || 1,
      );
      while (used.has(candidate)) candidate += 1;

      const patch: {
        project_key?: string;
        next_ticket_number: number;
      } = {
        next_ticket_number: candidate + 1,
      };
      if (!normalizeProjectKey(project.fields.project_key)) {
        patch.project_key = projectKey;
      }

      await this.client.updateEntry<Project>("project", project.id, {
        fields: patch,
      });
      await this.ensurePublished(
        "project",
        (await this.client.getEntryBySlug<Project>("project", projectSlug))!,
      );

      used.add(candidate);
      return {
        projectKey,
        ticketNumber: candidate,
        ticketKey: formatTicketKey(projectKey, candidate),
      };
    }

    throw new ValidationError(
      `Could not allocate a ticket number for project ${projectSlug}`,
    );
  }

  /**
   * Idempotent backfill: assign ticket_key / ticket_number to tickets that
   * lack them, oldest first per project, and advance next_ticket_number.
   */
  async backfillTicketKeys(projectSlug?: string): Promise<{
    updated: number;
    projects: string[];
  }> {
    await this.ensureReady();
    const projects = projectSlug
      ? ([
          await this.client.getEntryBySlug<Project>("project", projectSlug),
        ].filter(Boolean) as Project[])
      : await this.listProjects();

    const allTickets = await this.listAllEntries<Ticket>("ticket", {
      status: "published",
    });

    let updated = 0;
    const touched: string[] = [];

    for (const project of projects) {
      const projectKey = resolveProjectKey(project);
      const projectTickets = allTickets
        .filter((t) => t.fields.project === project.slug)
        .sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );

      let next = 1;
      for (const ticket of projectTickets) {
        const existingNumber = Number(ticket.fields.ticket_number);
        const existingKey = ticket.fields.ticket_key?.trim();
        if (
          existingKey &&
          Number.isFinite(existingNumber) &&
          existingNumber > 0
        ) {
          next = Math.max(next, existingNumber + 1);
          continue;
        }

        const ticketNumber =
          Number.isFinite(existingNumber) && existingNumber > 0
            ? existingNumber
            : next;
        const ticketKey =
          existingKey || formatTicketKey(projectKey, ticketNumber);

        await this.client.updateEntry<Ticket>("ticket", ticket.id, {
          fields: {
            ticket_key: ticketKey,
            ticket_number: ticketNumber,
          },
        });
        await this.ensurePublished(
          "ticket",
          (await this.client.getEntryBySlug<Ticket>("ticket", ticket.slug))!,
        );
        updated += 1;
        next = Math.max(next, ticketNumber + 1);
      }

      const patch: {
        project_key?: string;
        next_ticket_number: number;
      } = {
        next_ticket_number: Math.max(
          next,
          Number(project.fields.next_ticket_number) || 1,
        ),
      };
      if (!normalizeProjectKey(project.fields.project_key)) {
        patch.project_key = projectKey;
      }
      await this.client.updateEntry<Project>("project", project.id, {
        fields: patch,
      });
      await this.ensurePublished(
        "project",
        (await this.client.getEntryBySlug<Project>("project", project.slug))!,
      );
      this.invalidateSearchIndex(project.slug);
      touched.push(project.slug);
    }

    return { updated, projects: touched };
  }

  async createTicket(input: {
    project: string;
    title: string;
    description?: string;
    priority?: Priority | string;
    created_by?: string;
    workflow?: string;
    stage?: string;
    slug?: string;
    parent?: string | null;
  }): Promise<Ticket> {
    await this.ensureReady();
    const projectCtx = await this.getProject(input.project);
    if (!projectCtx) throw new NotFoundError(`Project not found: ${input.project}`);

    const defaultWorkflow =
      relationSlug(projectCtx.project.fields.default_workflow) ??
      projectCtx.workflow?.slug ??
      null;
    const projectWorkflows = await this.listWorkflows(input.project);
    const workflowSlug = input.workflow ?? defaultWorkflow;
    if (!workflowSlug) {
      throw new ValidationError(`No workflow configured for project ${input.project}`);
    }
    if (
      !isProjectWorkflow(
        workflowSlug,
        defaultWorkflow,
        projectWorkflows.map((w) => w.slug),
      )
    ) {
      throw new ValidationError(
        `Workflow "${workflowSlug}" is not a workflow of project ${input.project}`,
      );
    }

    const workflow =
      projectCtx.workflow?.slug === workflowSlug
        ? projectCtx.workflow
        : (await this.getWorkflow(workflowSlug))?.workflow;
    if (!workflow) {
      throw new ValidationError(
        `Workflow "${workflowSlug}" is not a workflow of project ${input.project}`,
      );
    }

    const doc = parseWorkflowDocument(workflow.fields.stages_json);
    const stages = doc.stages;
    if (input.stage && !stages.some((s) => s.key === input.stage)) {
      throw new ValidationError(
        `Stage "${input.stage}" is not in workflow ${workflowSlug}`,
      );
    }
    const stage = input.stage ?? firstStageKey(stages);
    if (!stage) throw new ValidationError("Workflow has no stages");

    const title = input.title?.trim() ?? "";
    if (!title) throw new ValidationError("Ticket title is required");
    const description = (input.description ?? "").trim();
    if (!description) {
      throw new ValidationError(
        "Ticket description is required (a short wish is enough for backlog)",
      );
    }

    // Backlog (first stage) accepts light wishes; playbook sections are
    // enforced when leaving backlog or when updating the description later.
    const intakeStage = firstStageKey(stages);
    if (stage !== intakeStage) {
      assertNoErrors(validateTicketDescription(description, doc.agent_policy));
    }

    const slug = await allocateUniqueEntrySlug(
      this.client,
      "ticket",
      input.slug ?? input.title,
    );

    const projectTickets = await this.listTickets({ project: input.project });
    const parentSlug =
      input.parent !== undefined
        ? await this.validateParentRefInProject({
            tickets: projectTickets,
            project: input.project,
            parentRef: input.parent,
          })
        : null;

    const identity = await this.allocateTicketIdentity(input.project);
    const now = new Date().toISOString();

    const ticket = await this.client.createEntry<Ticket>("ticket", {
      slug,
      status: "published",
      fields: {
        title,
        description,
        project: input.project,
        workflow: workflowSlug,
        stage,
        priority: input.priority ?? "medium",
        created_by: input.created_by ?? "agent",
        sort_order: projectTickets.length,
        ticket_key: identity.ticketKey,
        ticket_number: identity.ticketNumber,
        stage_entered_at: now,
        ...(parentSlug ? { parent: parentSlug } : {}),
      },
    });
    await this.ensurePublished("ticket", ticket);
    await this.upsertSearchTicket(ticket);
    return ticket;
  }

  private async resolveTicket(slugOrKey: string): Promise<Ticket | null> {
    const found = await this.getTicket(slugOrKey);
    return found?.ticket ?? null;
  }

  /**
   * Validate a parent ref against the project's own tickets.
   *
   * The scoped list cannot tell "belongs to another project" from "does not
   * exist", so a miss is re-checked with a targeted lookup before reporting.
   */
  private async validateParentRefInProject(input: {
    tickets: Ticket[];
    project: string;
    parentRef: string | null;
    selfSlug?: string;
  }): Promise<string | null> {
    try {
      return validateTicketParent({
        tickets: input.tickets,
        project: input.project,
        parentRef: input.parentRef,
        selfSlug: input.selfSlug,
      });
    } catch (error) {
      const notFound =
        error instanceof Error &&
        error.message.startsWith("Parent ticket not found");
      if (!notFound || !input.parentRef) throw error;
      const foreign = await this.resolveTicket(input.parentRef);
      if (!foreign) throw error;
      throw new ValidationError(
        `Parent ticket "${foreign.slug}" belongs to a different project.`,
      );
    }
  }

  async updateTicket(
    slug: string,
    input: {
      title?: string;
      description?: string;
      priority?: Priority | string;
      tokens_estimate?: number;
      sort_order?: number;
      resolution?: TicketResolution | string;
      parent?: string | null;
      workflow?: string;
      /** Comment author when a workflow pin-wissel writes an audit line. */
      author?: string;
    },
  ): Promise<Ticket> {
    await this.ensureReady();
    const ticket = await this.resolveTicket(slug);
    if (!ticket) throw new NotFoundError(`Ticket not found: ${slug}`);
    if (input.description != null) {
      const workflow = await this.client.getEntryBySlug<Workflow>(
        "workflow",
        ticket.fields.workflow,
      );
      if (workflow) {
        const policy = parseWorkflowDocument(workflow.fields.stages_json)
          .agent_policy;
        assertNoErrors(validateTicketDescription(input.description, policy));
      }
    }
    if (
      input.tokens_estimate != null &&
      (!Number.isInteger(input.tokens_estimate) || input.tokens_estimate < 0)
    ) {
      throw new ValidationError("tokens_estimate must be a non-negative integer");
    }
    if (input.sort_order != null) {
      assertNonNegativeIntegerSortOrder(input.sort_order);
    }
    if (input.resolution != null) {
      assertNoErrors(
        validateTransitionResolution({
          fromStage: { key: "x", name: "x", transitions: ["y"] },
          toStage: {
            key: "y",
            name: "y",
            transitions: [],
            agent: { require_resolution_on_enter: true },
          },
          resolution: input.resolution,
        }),
      );
    }
    let parentSlug: string | null | undefined;
    if (input.parent !== undefined) {
      const siblings = await this.listTickets({ project: ticket.fields.project });
      parentSlug = await this.validateParentRefInProject({
        tickets: siblings,
        project: ticket.fields.project,
        selfSlug: ticket.slug,
        parentRef: input.parent,
      });
    }

    let workflowFields: {
      workflow: string;
      stage: string;
      stage_entered_at: string;
      sort_order: number;
      review_state: "";
    } | null = null;
    let workflowAudit: string | null = null;
    if (input.workflow !== undefined) {
      const planned = await this.planTicketWorkflowReassign(
        ticket,
        input.workflow,
      );
      if (planned) {
        workflowFields = planned.fields;
        workflowAudit = planned.comment;
      }
    }

    const fields = {
      ...(input.title != null ? { title: input.title } : {}),
      ...(input.description != null ? { description: input.description } : {}),
      ...(input.priority != null ? { priority: input.priority } : {}),
      ...(input.tokens_estimate != null
        ? { tokens_estimate: input.tokens_estimate }
        : {}),
      ...(input.sort_order != null ? { sort_order: input.sort_order } : {}),
      ...(input.resolution != null ? { resolution: input.resolution } : {}),
      ...(parentSlug !== undefined ? { parent: parentSlug ?? "" } : {}),
      ...(workflowFields ?? {}),
    };
    if (Object.keys(fields).length === 0) {
      return ticket;
    }
    const updated = await this.client.updateEntry<Ticket>("ticket", ticket.id, {
      fields,
    });
    await this.ensurePublished("ticket", updated);
    await this.upsertSearchTicket(updated);
    if (workflowAudit) {
      await this.addComment({
        ticket: updated.slug,
        body: workflowAudit,
        author: input.author,
      });
    }
    return updated;
  }

  async claimTicket(
    slug: string,
    agentId: string | null | undefined,
    actorUserId?: string | null,
  ): Promise<Ticket> {
    await this.ensureReady();
    const ticket = await this.resolveTicket(slug);
    if (!ticket) throw new NotFoundError(`Ticket not found: ${slug}`);
    const parsed = parseClaimedAgentId(agentId);
    if (!parsed.ok) throw new ValidationError(parsed.message);
    const fields = claimPersistenceFields(parsed.value, actorUserId);
    if (fields.claimed_agent_id && !fields.claimed_by_user_id) {
      throw new ValidationError(
        "claim requires an authenticated actor (claimed_by_user_id)",
      );
    }
    const updated = await this.client.updateEntry<Ticket>("ticket", ticket.id, {
      fields,
    });
    await this.ensurePublished("ticket", updated);
    await this.upsertSearchTicket(updated);
    return updated;
  }

  private async planTicketWorkflowReassign(
    ticket: Ticket,
    rawWorkflow: string,
  ): Promise<{
    fields: {
      workflow: string;
      stage: string;
      stage_entered_at: string;
      sort_order: number;
      review_state: "";
    };
    comment: string;
  } | null> {
    const targetSlug = rawWorkflow.trim();
    if (!targetSlug) {
      throw new ValidationError("workflow is required");
    }
    const projectSlug = ticket.fields.project;
    const projectCtx = await this.getProject(projectSlug);
    if (!projectCtx) {
      throw new NotFoundError(`Project not found: ${projectSlug}`);
    }
    const defaultWorkflow =
      relationSlug(projectCtx.project.fields.default_workflow) ??
      projectCtx.workflow?.slug ??
      null;
    const projectWorkflows = await this.listWorkflows(projectSlug);
    const projectSlugs = projectWorkflows.map((w) => w.slug);
    const currentPin = ticket.fields.workflow ?? "";
    const currentWf = currentPin ? await this.getWorkflow(currentPin) : null;
    const currentFirst = currentWf ? firstStageKey(currentWf.stages) : null;
    if (
      !isTicketWorkflowReassignable({
        currentPin,
        currentStage: ticket.fields.stage,
        liveFirstStageKey: currentFirst,
        defaultWorkflow,
        projectWorkflowSlugs: projectSlugs,
      })
    ) {
      const stageName =
        currentWf?.stages[0]?.name ?? currentFirst ?? "first stage";
      throw new ValidationError(
        `Workflow can only be changed while the ticket is in the first stage ("${stageName}").`,
      );
    }
    if (!isProjectWorkflow(targetSlug, defaultWorkflow, projectSlugs)) {
      throw new ValidationError(
        `Workflow "${targetSlug}" is not a workflow of project ${projectSlug}`,
      );
    }
    if (targetSlug === currentPin) {
      return null;
    }
    const targetWf = await this.getWorkflow(targetSlug);
    if (!targetWf) {
      throw new ValidationError(
        `Workflow "${targetSlug}" is not a workflow of project ${projectSlug}`,
      );
    }
    const newStage = firstStageKey(targetWf.stages);
    if (!newStage) {
      throw new ValidationError(`Workflow "${targetSlug}" has no stages`);
    }
    const siblings = await this.listTickets({ project: projectSlug });
    const sort_order = nextColumnSortOrder(
      siblings
        .filter(
          (t) =>
            t.fields.workflow === targetSlug && t.fields.stage === newStage,
        )
        .map((t) => t.fields.sort_order),
    );
    return {
      fields: {
        workflow: targetSlug,
        stage: newStage,
        stage_entered_at: new Date().toISOString(),
        sort_order,
        ...CLEARED_REVIEW_FIELDS,
      },
      comment: workflowReassignAuditComment(
        currentWf?.workflow.fields.name || currentPin,
        targetWf.workflow.fields.name || targetSlug,
      ),
    };
  }

  /**
   * Persist vertical board order for one project stage. Sets `sort_order` to
   * the index in `ordered_slugs` and returns only tickets whose order changed.
   */
  async reorderTickets(input: {
    project: string;
    stage: string;
    workflow: string;
    ordered_slugs: string[];
  }): Promise<Ticket[]> {
    await this.ensureReady();
    const projectTickets = await this.listTickets({ project: input.project });
    const updates = planTicketReorder({
      project: input.project,
      stage: input.stage,
      workflow: input.workflow,
      ordered_slugs: input.ordered_slugs,
      tickets: projectTickets.map((t) => ({
        slug: t.slug,
        project: t.fields.project,
        stage: t.fields.stage,
        workflow: t.fields.workflow,
        sort_order: t.fields.sort_order,
      })),
    });
    const changed: Ticket[] = [];
    for (const update of updates) {
      const ticket = projectTickets.find((t) => t.slug === update.slug);
      if (!ticket) continue;
      const updated = await this.client.updateEntry<Ticket>("ticket", ticket.id, {
        fields: { sort_order: update.sort_order },
      });
      await this.ensurePublished("ticket", updated);
      changed.push(this.normalizeTicketRelations(updated));
    }
    return changed;
  }

  async transitionTicket(
    slug: string,
    toStage: string,
    options?: {
      comment?: string;
      author?: string;
      tokens_estimate?: number;
      tokens_used?: number;
      resolution?: TicketResolution | string;
      expected_stage?: string;
      expected_review_state?: string | null;
      /** True when expected_review_state was present on the request (including null). */
      reviewStateProvided?: boolean;
      /** Set only by the human-proxy API path (web session). */
      asHuman?: boolean;
    },
  ): Promise<Ticket> {
    await this.ensureReady();
    const ticket = await this.resolveTicket(slug);
    if (!ticket) throw new NotFoundError(`Ticket not found: ${slug}`);
    const workflow = await this.client.getEntryBySlug<Workflow>(
      "workflow",
      ticket.fields.workflow,
    );
    if (!workflow) throw new NotFoundError(`Workflow not found: ${ticket.fields.workflow}`);
    const doc = parseWorkflowDocument(workflow.fields.stages_json);
    const stages = doc.stages;
    const fromStage = stages.find((s) => s.key === ticket.fields.stage);
    await enforceExpectedTransition({
      require: doc.agent_policy.require_expected_stage_on_transition === true,
      asHuman: options?.asHuman === true,
      gatedStage: fromStage?.agent?.require_human_approval_on_exit === true,
      expected_stage: options?.expected_stage,
      expected_review_state: options?.expected_review_state,
      reviewStateProvided: options?.reviewStateProvided === true,
      current_stage: ticket.fields.stage,
      current_review_state: ticket.fields.review_state || null,
      to_stage: toStage,
      stage_entered_at: ticket.fields.stage_entered_at ?? null,
      loadComments: async () => {
        const comments = await this.listCommentsForTickets([ticket.slug]);
        return comments.map((c) => ({
          author: c.fields.author ?? "",
          createdAt: c.createdAt,
          body: c.fields.body ?? "",
        }));
      },
    });
    if (!canTransition(stages, ticket.fields.stage, toStage)) {
      throw new ValidationError(
        `Transition from "${ticket.fields.stage}" to "${toStage}" is not allowed`,
      );
    }
    const targetStage = stages.find((s) => s.key === toStage);
    if (!fromStage || !targetStage) {
      throw new ValidationError("Invalid workflow stage for transition");
    }
    assertHumanGateTransition({
      stages,
      fromStage,
      toStage: targetStage,
      asHuman: options?.asHuman === true,
      reviewState: ticket.fields.review_state,
    });
    assertNoErrors(
      validateHumanGateExit({
        fromStage,
        toStage: targetStage,
        asHuman: options?.asHuman === true,
        comment: options?.comment,
        reviewState: ticket.fields.review_state,
      }),
    );
    assertNoErrors(
      validateTransitionComment({
        fromStage,
        toStage: targetStage,
        policy: doc.agent_policy,
        comment: options?.comment,
      }),
    );
    assertNoErrors(
      validateTransitionTokens({
        fromStage,
        toStage: targetStage,
        policy: doc.agent_policy,
        tokens_estimate: options?.tokens_estimate,
        tokens_used: options?.tokens_used,
      }),
    );
    assertNoErrors(
      validateTransitionResolution({
        fromStage,
        toStage: targetStage,
        resolution: options?.resolution,
      }),
    );

    // Playbook-complete description only when the stage asks for it on this target.
    if (exitRequiresPlaybookDescription(fromStage, toStage)) {
      assertNoErrors(
        validateTicketDescription(ticket.fields.description, doc.agent_policy),
      );
    }

    if (options?.comment?.trim()) {
      await this.addComment({
        ticket: ticket.slug,
        body: options.comment,
        author: options.author ?? "agent",
      });
    }

    const now = new Date().toISOString();
    const fields: Record<string, unknown> = {
      stage: toStage,
      stage_entered_at: now,
      // A verdict belongs to a single review round.
      ...CLEARED_REVIEW_FIELDS,
    };
    if (
      exitRequiresTokensEstimate(fromStage, toStage) &&
      options?.tokens_estimate != null
    ) {
      fields.tokens_estimate = options.tokens_estimate;
    }
    if (options?.tokens_used != null) {
      const previous = Number(ticket.fields.tokens_actual ?? 0);
      fields.tokens_actual =
        (Number.isFinite(previous) ? previous : 0) + options.tokens_used;
    }
    if (
      fromStage.key !== toStage &&
      targetStage.agent?.require_resolution_on_enter === true &&
      options?.resolution
    ) {
      fields.resolution = options.resolution;
    }

    const updated = await this.client.updateEntry<Ticket>("ticket", ticket.id, {
      fields,
    });
    await this.ensurePublished("ticket", updated);
    await this.upsertSearchTicket(updated);
    return updated;
  }

  /**
   * Record a human review verdict on the ticket without moving it. The agent
   * reads the verdict and performs the matching transition afterwards.
   * When `apply_to_children` is true, the same verdict is also written to every
   * descendant currently in a human-gated stage (no stage change).
   */
  async recordReviewVerdict(
    slug: string,
    input: {
      verdict: TicketReviewState | string;
      comment?: string;
      author?: string;
      apply_to_children?: boolean;
    },
  ): Promise<{ ticket: Ticket; cascaded: Ticket[] }> {
    await this.ensureReady();
    const ticket = await this.resolveTicket(slug);
    if (!ticket) throw new NotFoundError(`Ticket not found: ${slug}`);
    const updated = await this.writeReviewVerdict(ticket, {
      verdict: input.verdict,
      comment: input.comment,
      author: input.author,
    });

    const cascaded: Ticket[] = [];
    if (input.apply_to_children === true) {
      const projectTickets = await this.listTickets({
        project: ticket.fields.project,
      });
      const descendantSlugs = listDescendantSlugs(projectTickets, ticket.slug);
      for (const childSlug of descendantSlugs) {
        const child = projectTickets.find((t) => t.slug === childSlug);
        if (!child) continue;
        const workflow = await this.client.getEntryBySlug<Workflow>(
          "workflow",
          child.fields.workflow,
        );
        if (!workflow) continue;
        const stages = parseWorkflowDocument(workflow.fields.stages_json).stages;
        const stage = stages.find((s) => s.key === child.fields.stage);
        if (stage?.agent?.require_human_approval_on_exit !== true) continue;
        const childUpdated = await this.writeReviewVerdict(child, {
          verdict: input.verdict,
          comment: input.comment,
          author: input.author,
          cascadedFrom: ticket.slug,
        });
        cascaded.push(childUpdated);
      }
    }

    return { ticket: updated, cascaded };
  }

  private async writeReviewVerdict(
    ticket: Ticket,
    input: {
      verdict: TicketReviewState | string;
      comment?: string;
      author?: string;
      cascadedFrom?: string;
    },
  ): Promise<Ticket> {
    const workflow = await this.client.getEntryBySlug<Workflow>(
      "workflow",
      ticket.fields.workflow,
    );
    if (!workflow) throw new NotFoundError(`Workflow not found: ${ticket.fields.workflow}`);
    const stages = parseWorkflowDocument(workflow.fields.stages_json).stages;
    const stage = stages.find((s) => s.key === ticket.fields.stage);
    if (!stage) throw new ValidationError("Invalid workflow stage for review verdict");
    assertNoErrors(
      validateReviewVerdict({
        stage,
        verdict: input.verdict,
        comment: input.comment,
      }),
    );

    const verdict = input.verdict as TicketReviewState;
    const author = input.author?.trim() || "human";
    const now = new Date().toISOString();
    const target = reviewVerdictTarget(stage, verdict);
    const cascadeNote = input.cascadedFrom
      ? ` (doorgezet vanaf parent "${input.cascadedFrom}")`
      : "";
    const body = formatReviewVerdictComment({
      stage,
      verdict,
      author,
      target,
      comment: input.comment,
      cascadeNote,
    });
    await this.addComment({ ticket: ticket.slug, body, author });

    const updated = await this.client.updateEntry<Ticket>("ticket", ticket.id, {
      fields: {
        review_state: verdict,
        review_by: author,
        review_at: now,
      },
    });
    await this.ensurePublished("ticket", updated);
    await this.upsertSearchTicket(updated);
    return updated;
  }

  async addComment(input: {
    ticket: string;
    body: string;
    author?: string;
  }): Promise<Comment> {
    await this.ensureReady();
    const ticket = await this.resolveTicket(input.ticket);
    if (!ticket) throw new NotFoundError(`Ticket not found: ${input.ticket}`);
    const existing = await this.listCommentsForTickets([ticket.slug], {});
    const slug = uniqueSlug(
      `${ticket.slug}-comment`,
      new Set(existing.map((c) => c.slug)),
    );
    const comment = await this.client.createEntry<Comment>("comment", {
      slug,
      status: "published",
      fields: {
        ticket: ticket.slug,
        body: input.body,
        author: input.author ?? "agent",
      },
    });
    await this.ensurePublished("comment", comment);
    await this.upsertSearchTicket(ticket);
    return comment;
  }

  /**
   * All published wiki pages of one project, in tree order (sort_order, title).
   * Uses Aurora `field`/`in` so the project filter runs server-side, and pages
   * through everything — the number of wiki pages in Aurora must never decide
   * which pages of this project come back.
   */
  private async loadProjectWikiPages(project: string): Promise<WikiPage[]> {
    const scoped = await this.listAllEntries<WikiPage>(WIKI_PAGE_CONTENT_TYPE, {
      status: "published",
      field: "project",
      in: [project],
    });
    const matches = (pages: WikiPage[]) =>
      sortWikiPages(
        pages
          .map((p) => this.normalizeWikiRelations(p))
          .filter((p) => p.fields.project === project),
      );

    const filtered = matches(scoped);
    if (filtered.length > 0) return filtered;
    // Relation fields may be stored as objects rather than slugs, in which case
    // the server-side filter matches nothing. An empty result is indistinguishable
    // from "no pages yet", so confirm with a full scan before believing it.
    return matches(
      await this.listAllEntries<WikiPage>(WIKI_PAGE_CONTENT_TYPE, {
        status: "published",
      }),
    );
  }

  async listWikiPages(input: {
    project: string;
    parent?: string | null;
    limit?: number;
    offset?: number;
  }): Promise<{
    items: WikiPage[];
    total: number;
    limit: number;
    offset: number;
  }> {
    await this.ensureReady();
    const project = await this.client.getEntryBySlug<Project>(
      "project",
      input.project,
    );
    if (!project) throw new NotFoundError(`Project not found: ${input.project}`);

    return selectWikiPages({
      pages: await this.loadProjectWikiPages(input.project),
      parent: input.parent,
      limit: input.limit,
      offset: input.offset,
    });
  }

  async getWikiPage(slug: string): Promise<WikiPage | null> {
    await this.ensureReady();
    const page = await this.client.getEntryBySlug<WikiPage>(
      WIKI_PAGE_CONTENT_TYPE,
      slug,
    );
    return page ? this.normalizeWikiRelations(page) : null;
  }

  /**
   * Resolve a wiki page within a project by Aurora entry slug or logical slug
   * (e.g. `home` → `acme-wp-home` when namespaced).
   */
  async getWikiPageInProject(
    projectSlug: string,
    slugOrLogical: string,
  ): Promise<WikiPage | null> {
    await this.ensureReady();
    const want = slugOrLogical.trim();
    if (!want) return null;

    const exact = await this.getWikiPage(want);
    if (exact && exact.fields.project === projectSlug) return exact;

    const pages = await this.loadProjectWikiPages(projectSlug);
    const entrySlug = resolveWikiEntrySlugInProject({
      project: projectSlug,
      slugOrLogical: want,
      pages,
    });
    if (!entrySlug) return null;
    if (entrySlug === want && exact) return exact;
    return this.getWikiPage(entrySlug);
  }

  private async assertWikiParent(
    project: string,
    parentSlug: string | null | undefined,
    selfSlug?: string,
  ): Promise<string | null> {
    if (parentSlug == null || parentSlug === "") return null;
    const projectPages = await this.loadProjectWikiPages(project);
    const resolvedParent =
      resolveWikiEntrySlugInProject({
        project,
        slugOrLogical: parentSlug,
        pages: projectPages,
      }) ?? parentSlug;
    const bySlug = new Map(projectPages.map((p) => [p.slug, p] as const));
    const parent = bySlug.get(resolvedParent);
    if (!parent) {
      // Not in this project — look the entry up directly so "belongs to another
      // project" stays distinguishable from "does not exist".
      const foreign = await this.getWikiPage(resolvedParent);
      if (foreign) {
        throw new ValidationError(
          `Parent wiki page "${parentSlug}" belongs to a different project.`,
        );
      }
      throw new NotFoundError(`Parent wiki page not found: ${parentSlug}`);
    }
    if (selfSlug && resolvedParent === selfSlug) {
      throw new ValidationError("A wiki page cannot be its own parent.");
    }
    if (!selfSlug) return resolvedParent;
    const seen = new Set<string>([selfSlug]);
    let cursor: string | null = resolvedParent;
    while (cursor) {
      if (seen.has(cursor)) {
        throw new ValidationError(
          `Setting parent "${parentSlug}" would create a cycle in the wiki tree.`,
        );
      }
      seen.add(cursor);
      const ancestor = bySlug.get(cursor);
      cursor = relationSlug(ancestor?.fields.parent);
    }
    return resolvedParent;
  }

  async createWikiPage(input: {
    project: string;
    title: string;
    body?: string;
    parent?: string | null;
    sort_order?: number;
    slug?: string;
    updated_by?: string;
  }): Promise<WikiPage> {
    await this.ensureReady();
    const title = input.title?.trim();
    if (!title) throw new ValidationError("title is required");
    const project = await this.client.getEntryBySlug<Project>(
      "project",
      input.project,
    );
    if (!project) throw new NotFoundError(`Project not found: ${input.project}`);
    const parentEntrySlug = await this.assertWikiParent(
      input.project,
      input.parent,
    );
    const projectPages = await this.loadProjectWikiPages(input.project);
    const logicalDesired =
      input.slug?.trim() ||
      uniqueSlug(
        title,
        new Set(
          projectPages.map((p) => wikiLogicalSlug(p.slug, input.project)),
        ),
      );
    const logicalInProject = projectPages.some(
      (p) => wikiLogicalSlug(p.slug, input.project) === logicalDesired,
    );
    if (logicalInProject) {
      throw new ValidationError(
        `Wiki page slug already exists in project: ${logicalDesired}`,
      );
    }
    const bareTaken = await this.client.getEntryBySlug(
      WIKI_PAGE_CONTENT_TYPE,
      logicalDesired,
    );
    let slug: string;
    if (!bareTaken) {
      slug = logicalDesired;
    } else {
      const namespaced = wikiEntrySlug(input.project, logicalDesired);
      const namespacedTaken = await this.client.getEntryBySlug(
        WIKI_PAGE_CONTENT_TYPE,
        namespaced,
      );
      if (namespacedTaken) {
        throw new ValidationError(`Wiki page slug already exists: ${namespaced}`);
      }
      slug = namespaced;
    }
    const siblings = projectPages.filter(
      (p) => (p.fields.parent || null) === (parentEntrySlug || null),
    );
    const page = await this.client.createEntry<WikiPage>(
      WIKI_PAGE_CONTENT_TYPE,
      {
        slug,
        status: "published",
        fields: {
          title,
          body: input.body ?? "",
          project: input.project,
          ...(parentEntrySlug ? { parent: parentEntrySlug } : {}),
          sort_order:
            input.sort_order ??
            siblings.reduce(
              (max, p) => Math.max(max, p.fields.sort_order ?? 0),
              -1,
            ) + 1,
          updated_by: input.updated_by ?? "agent",
        },
      },
    );
    await this.ensurePublished(WIKI_PAGE_CONTENT_TYPE, page);
    this.upsertSearchWikiPage(page);
    return page;
  }

  /**
   * Update a wiki page. `body` replaces the whole Markdown value; `edits`
   * patches fragments of it via Aurora's atomic `field_edits` (CMS-53) so
   * untouched text stays byte-identical and a stale anchor fails loudly.
   *
   * The two are mutually exclusive: this service never reads the body to patch
   * it itself, because a client cannot make read-modify-write atomic.
   */
  async updateWikiPage(
    slug: string,
    input: {
      title?: string;
      body?: string;
      edits?: FieldEdit[];
      parent?: string | null;
      sort_order?: number;
      updated_by?: string;
    },
  ): Promise<{ page: WikiPage; applied_edits?: number }> {
    await this.ensureReady();
    if (input.edits && input.body != null) {
      throw new ValidationError(
        "Pass either body (full replace) or edits (patch), not both.",
      );
    }
    const page = await this.client.getEntryBySlug<WikiPage>(
      WIKI_PAGE_CONTENT_TYPE,
      slug,
    );
    if (!page) throw new NotFoundError(`Wiki page not found: ${slug}`);
    let parentEntrySlug: string | null | undefined;
    if (input.parent !== undefined) {
      parentEntrySlug = await this.assertWikiParent(
        page.fields.project,
        input.parent,
        slug,
      );
    }
    const updated = await this.client.updateEntry<
      WikiPage & { fieldEditSummary?: FieldEditSummary }
    >(WIKI_PAGE_CONTENT_TYPE, page.id, {
      fields: {
        ...(input.title != null ? { title: input.title.trim() } : {}),
        ...(input.body != null ? { body: input.body } : {}),
        ...(input.parent !== undefined
          ? { parent: parentEntrySlug || "" }
          : {}),
        ...(input.sort_order != null ? { sort_order: input.sort_order } : {}),
        ...(input.updated_by != null ? { updated_by: input.updated_by } : {}),
      },
      ...(input.edits ? { field_edits: { body: input.edits } } : {}),
    });
    await this.ensurePublished(WIKI_PAGE_CONTENT_TYPE, updated);
    this.upsertSearchWikiPage(updated);
    // Aurora also reports a per-field length; it is wrong today (CMS-53), so
    // only the applied count is surfaced.
    return { page: updated, applied_edits: updated.fieldEditSummary?.applied };
  }

  /**
   * True when at least one personal `traceai_user` is active with a password,
   * or (legacy) Aurora `app_login`/`default` is configured.
   */
  async isAppLoginConfigured(): Promise<boolean> {
    return this.isUiLoginConfigured();
  }

  async isUiLoginConfigured(): Promise<boolean> {
    await this.ensureReady();
    if (await this.hasPersonalLoginUsers()) return true;
    return this.isLegacyAppLoginConfigured();
  }

  private async isLegacyAppLoginConfigured(): Promise<boolean> {
    const entry = await this.client.getEntryBySlug<AppLogin>(
      APP_LOGIN_CONTENT_TYPE,
      APP_LOGIN_ENTRY_SLUG,
    );
    if (!entry) return false;
    const username =
      typeof entry.fields.username === "string"
        ? entry.fields.username.trim()
        : "";
    return Boolean(username && this.isPasswordSet(entry.fields.password));
  }

  private isPasswordSet(password: unknown): boolean {
    return (
      typeof password === "object" &&
      password !== null &&
      (password as { set?: unknown }).set === true
    );
  }

  private async hasPersonalLoginUsers(): Promise<boolean> {
    const users = await this.listTraceaiUsers();
    return users.some(
      (u) =>
        u.fields.status === "active" && this.isPasswordSet(u.fields.password),
    );
  }

  /**
   * Verify UI login. Prefers personal `traceai_user` entries; falls back to
   * legacy shared `app_login`/`default` when no personal users exist.
   */
  async verifyAppLogin(
    username: string,
    password: string,
  ): Promise<
    | { ok: true; user: string; identity: UiIdentity }
    | { ok: false; reason: "not_configured" | "invalid" }
  > {
    return this.verifyUiLogin(username, password);
  }

  async verifyUiLogin(
    username: string,
    password: string,
  ): Promise<
    | { ok: true; user: string; identity: UiIdentity }
    | { ok: false; reason: "not_configured" | "invalid" }
  > {
    await this.ensureReady();
    const want = username.trim();
    if (!want || !password) {
      return { ok: false, reason: "invalid" };
    }

    const personalConfigured = await this.hasPersonalLoginUsers();
    if (personalConfigured) {
      const user = await this.findTraceaiUserByUsername(want);
      if (!user || user.fields.status !== "active") {
        return { ok: false, reason: "invalid" };
      }
      if (!this.isPasswordSet(user.fields.password)) {
        return { ok: false, reason: "not_configured" };
      }
      try {
        const result = await this.client.verifyCredentials(
          TRACEAI_USER_CONTENT_TYPE,
          {
            slug: user.slug,
            username: want,
            password,
          },
        );
        const loginUser =
          typeof result.username === "string" && result.username.trim()
            ? result.username.trim()
            : want;
        const identity: UiIdentity = {
          user: loginUser,
          slug: user.slug,
          display_name: user.fields.display_name || loginUser,
          is_platform_admin: user.fields.is_platform_admin === true,
          mode: "personal",
        };
        return { ok: true, user: loginUser, identity };
      } catch (error) {
        return this.mapCredentialError(error);
      }
    }

    if (!(await this.isLegacyAppLoginConfigured())) {
      return { ok: false, reason: "not_configured" };
    }
    try {
      const result = await this.client.verifyCredentials(
        APP_LOGIN_CONTENT_TYPE,
        {
          slug: APP_LOGIN_ENTRY_SLUG,
          username: want,
          password,
        },
      );
      const loginUser =
        typeof result.username === "string" && result.username.trim()
          ? result.username.trim()
          : want;
      const identity: UiIdentity = {
        user: loginUser,
        slug: null,
        display_name: loginUser,
        is_platform_admin: true,
        mode: "legacy",
      };
      return { ok: true, user: loginUser, identity };
    } catch (error) {
      return this.mapCredentialError(error);
    }
  }

  private mapCredentialError(
    error: unknown,
  ): { ok: false; reason: "not_configured" | "invalid" } {
    if (error instanceof AuroraApiError) {
      if (error.status === 401) {
        return { ok: false, reason: "invalid" };
      }
      const code =
        typeof error.body === "object" &&
        error.body &&
        "code" in error.body &&
        typeof (error.body as { code: unknown }).code === "string"
          ? (error.body as { code: string }).code
          : "";
      if (
        error.status === 400 ||
        error.status === 404 ||
        code === "PASSWORD_NOT_SET" ||
        code === "PASSWORD_FIELD_NOT_FOUND"
      ) {
        return { ok: false, reason: "not_configured" };
      }
    }
    throw error;
  }

  async listTraceaiUsers(): Promise<TraceaiUser[]> {
    await this.ensureReady();
    const items = await this.listAllEntries<TraceaiUser>(
      TRACEAI_USER_CONTENT_TYPE,
    );
    return items.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async getTraceaiUser(slug: string): Promise<TraceaiUser | null> {
    await this.ensureReady();
    return this.client.getEntryBySlug<TraceaiUser>(
      TRACEAI_USER_CONTENT_TYPE,
      slug,
    );
  }

  async findTraceaiUserByUsername(
    username: string,
  ): Promise<TraceaiUser | null> {
    const want = username.trim().toLowerCase();
    if (!want) return null;
    const users = await this.listTraceaiUsers();
    return (
      users.find(
        (u) =>
          u.fields.username.trim().toLowerCase() === want ||
          u.slug.toLowerCase() === want,
      ) ?? null
    );
  }

  async createTraceaiUser(input: {
    username: string;
    password: string;
    display_name: string;
    email?: string;
    status?: string;
    is_platform_admin?: boolean;
    slug?: string;
  }): Promise<TraceaiUser> {
    await this.ensureReady();
    const username = input.username.trim();
    if (!username) throw new ValidationError("username is required");
    if (!input.password) throw new ValidationError("password is required");
    const display_name = input.display_name.trim() || username;
    const existing = await this.listTraceaiUsers();
    if (
      existing.some(
        (u) => u.fields.username.trim().toLowerCase() === username.toLowerCase(),
      )
    ) {
      throw new ValidationError(`User already exists: ${username}`);
    }
    const slug = uniqueSlug(
      input.slug?.trim() || username,
      new Set(existing.map((u) => u.slug)),
    );
    const user = await this.client.createEntry<TraceaiUser>(
      TRACEAI_USER_CONTENT_TYPE,
      {
        slug,
        status: "published",
        fields: {
          username,
          password: input.password,
          display_name,
          email: input.email?.trim() || null,
          status: input.status?.trim() || "active",
          is_platform_admin: input.is_platform_admin === true,
        },
      },
    );
    await this.ensurePublished(TRACEAI_USER_CONTENT_TYPE, user);
    return user;
  }

  async updateTraceaiUser(
    slug: string,
    input: {
      display_name?: string;
      email?: string | null;
      status?: string;
      is_platform_admin?: boolean;
      password?: string;
    },
  ): Promise<TraceaiUser> {
    await this.ensureReady();
    const user = await this.getTraceaiUser(slug);
    if (!user) throw new NotFoundError(`User not found: ${slug}`);

    const nextStatus =
      input.status != null ? input.status.trim() || "active" : undefined;
    if (
      wouldRemoveLastPlatformAdmin(
        (await this.listTraceaiUsers()).map((u) => ({
          slug: u.slug,
          status: u.fields.status,
          is_platform_admin: u.fields.is_platform_admin === true,
        })),
        slug,
        {
          ...(nextStatus != null ? { status: nextStatus } : {}),
          ...(input.is_platform_admin !== undefined
            ? { is_platform_admin: input.is_platform_admin }
            : {}),
        },
      )
    ) {
      throw new ValidationError(
        "Cannot disable or demote the last active platform admin",
      );
    }

    const fields: Record<string, unknown> = {};
    if (input.display_name != null) {
      fields.display_name = input.display_name.trim() || user.fields.username;
    }
    if (input.email !== undefined) {
      fields.email = input.email?.trim() || null;
    }
    if (nextStatus != null) {
      fields.status = nextStatus;
    }
    if (input.is_platform_admin !== undefined) {
      fields.is_platform_admin = input.is_platform_admin === true;
    }
    if (input.password) {
      fields.password = input.password;
    }
    const updated = await this.client.updateEntry<TraceaiUser>(
      TRACEAI_USER_CONTENT_TYPE,
      user.id,
      { fields },
    );
    await this.ensurePublished(TRACEAI_USER_CONTENT_TYPE, updated);

    // Disabling a user cleans memberships so Aurora relations cannot dangle
    // after a TraceAI-managed disable (there is no hard user delete today).
    if (
      nextStatus != null &&
      nextStatus !== "active" &&
      (user.fields.status || "active") === "active"
    ) {
      await this.removeMembershipsForUser(slug);
    }

    return updated;
  }

  async listProjectMemberships(
    project?: string,
  ): Promise<ProjectMembership[]> {
    await this.ensureReady();
    const items = (
      await this.listAllEntries<ProjectMembership>(
        PROJECT_MEMBERSHIP_CONTENT_TYPE,
        { status: "published" },
      )
    ).map((m) => this.normalizeMembershipRelations(m));
    if (!project) {
      return items.sort((a, b) => a.slug.localeCompare(b.slug));
    }
    return items
      .filter((m) => m.fields.project === project)
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async getUserProjectRole(
    projectSlug: string,
    userSlug: string,
  ): Promise<ProjectRole | null> {
    const memberships = await this.listProjectMemberships(projectSlug);
    const match = memberships.find((m) => m.fields.user === userSlug);
    if (!match) return null;
    return isProjectRole(match.fields.role) ? match.fields.role : null;
  }

  async assertProjectRole(input: {
    projectSlug: string;
    userSlug: string | null;
    isPlatformAdmin?: boolean;
    required: ProjectRole;
  }): Promise<ProjectRole | "platform_admin"> {
    if (input.isPlatformAdmin) return "platform_admin";
    if (!input.userSlug) {
      throw new ForbiddenError(
        `Missing project membership for role ${input.required} on ${input.projectSlug}`,
      );
    }
    const role = await this.getUserProjectRole(
      input.projectSlug,
      input.userSlug,
    );
    if (!roleAtLeast(role, input.required)) {
      throw new ForbiddenError(
        `Requires project role ${input.required} on ${input.projectSlug} (have ${role ?? "none"})`,
      );
    }
    return role!;
  }

  async setProjectMembership(input: {
    project: string;
    user: string;
    role: ProjectRole;
  }): Promise<ProjectMembership> {
    await this.ensureReady();
    const project = input.project.trim();
    const user = input.user.trim();
    if (!project || !user) throw new ValidationError("project and user are required");
    if (!isProjectRole(input.role)) {
      throw new ValidationError(`Invalid role: ${input.role}`);
    }
    const projectEntry = await this.client.getEntryBySlug<Project>(
      "project",
      project,
    );
    if (!projectEntry) throw new NotFoundError(`Project not found: ${project}`);
    const userEntry = await this.getTraceaiUser(user);
    if (!userEntry) throw new NotFoundError(`User not found: ${user}`);

    const slug = membershipSlug(project, user);
    const existing = await this.client.getEntryBySlug<ProjectMembership>(
      PROJECT_MEMBERSHIP_CONTENT_TYPE,
      slug,
    );
    if (existing) {
      const updated = await this.client.updateEntry<ProjectMembership>(
        PROJECT_MEMBERSHIP_CONTENT_TYPE,
        existing.id,
        {
          fields: {
            project,
            user,
            role: input.role,
          },
        },
      );
      await this.ensurePublished(PROJECT_MEMBERSHIP_CONTENT_TYPE, updated);
      return updated;
    }
    const created = await this.client.createEntry<ProjectMembership>(
      PROJECT_MEMBERSHIP_CONTENT_TYPE,
      {
        slug,
        status: "published",
        fields: {
          project,
          user,
          role: input.role,
        },
      },
    );
    await this.ensurePublished(PROJECT_MEMBERSHIP_CONTENT_TYPE, created);
    return created;
  }

  async removeProjectMembership(
    project: string,
    user: string,
  ): Promise<boolean> {
    await this.ensureReady();
    const slug = membershipSlug(project.trim(), user.trim());
    const existing = await this.client.getEntryBySlug<ProjectMembership>(
      PROJECT_MEMBERSHIP_CONTENT_TYPE,
      slug,
    );
    if (!existing) return false;
    await this.client.deleteEntry(PROJECT_MEMBERSHIP_CONTENT_TYPE, existing.id);
    return true;
  }

  /** Remove every membership for a user (used when disabling the account). */
  async removeMembershipsForUser(userSlug: string): Promise<number> {
    const want = userSlug.trim();
    if (!want) return 0;
    const memberships = await this.listProjectMemberships();
    let removed = 0;
    for (const m of memberships) {
      if (m.fields.user !== want) continue;
      const ok = await this.removeProjectMembership(m.fields.project, want);
      if (ok) removed += 1;
    }
    return removed;
  }

  private normalizeTicketRelations(ticket: Ticket): Ticket {
    const parent = relationSlug(ticket.fields.parent);
    return {
      ...ticket,
      fields: {
        ...ticket.fields,
        project: relationSlugOrEmpty(ticket.fields.project),
        workflow: relationSlugOrEmpty(ticket.fields.workflow),
        parent: parent,
      },
    };
  }

  private normalizeWikiRelations(page: WikiPage): WikiPage {
    return {
      ...page,
      fields: {
        ...page.fields,
        project: relationSlugOrEmpty(page.fields.project),
        parent: relationSlug(page.fields.parent),
      },
    };
  }

  private normalizeMembershipRelations(
    membership: ProjectMembership,
  ): ProjectMembership {
    return {
      ...membership,
      fields: {
        ...membership.fields,
        project: relationSlugOrEmpty(membership.fields.project),
        user: relationSlugOrEmpty(membership.fields.user),
        role: String(membership.fields.role ?? ""),
      },
    };
  }

  private async ensurePublished(
    apiId: string,
    entry: { id: string; status: string },
  ) {
    // Always publish so public API reflects the latest fields after create/update.
    await this.client.publishEntry(apiId, entry.id);
  }
}
