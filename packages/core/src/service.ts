import {
  AURORA_FIELD_IN_MAX,
  AuroraApiError,
  AuroraManagementClient,
  type AuroraClientConfig,
  type ListEntriesQuery,
} from "./aurora.js";
import {
  assertNonNegativeIntegerSortOrder,
  planTicketReorder,
} from "./reorder.js";
import {
  DEFAULT_STAGES,
  DEFAULT_WORKFLOW_DOCUMENT,
  canTransition,
  deriveProjectKeyFromSlug,
  exitRequiresPlaybookDescription,
  exitRequiresTokensEstimate,
  firstStageKey,
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
  buildReviewInboxItems,
  type ReviewInboxItem,
} from "./review-inbox.js";
import {
  computeProjectInsights,
  paginateItems,
  searchProjectContent,
  sortTicketsNewestFirst,
  type Paginated,
  type ProjectInsights,
  type SearchFilters,
  type SearchHit,
} from "./insights.js";
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
};

function uniqueSlug(base: string, existing: Set<string>): string {
  let candidate = slugify(base);
  if (!existing.has(candidate)) return candidate;
  let i = 2;
  while (existing.has(`${candidate}-${i}`)) i += 1;
  return `${candidate}-${i}`;
}

function assertNoErrors(errors: string[]) {
  if (errors.length) {
    throw new Error(errors.join(" "));
  }
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
  private ready: Promise<void> | null = null;

  constructor(options: TraceServiceOptions) {
    this.client = new AuroraManagementClient(options);
    this.websiteId = options.websiteId;
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
   * Page through all entries of a content type. Aurora caps `limit` at 100, so
   * anything that can exceed that must paginate instead of asking for more.
   * Prefer `field` + `in` for parent/child selections (max 50 values per page
   * request — callers must chunk larger IN-lists).
   */
  private async listAllEntries<T>(
    apiId: string,
    query: Pick<ListEntriesQuery, "status" | "field" | "in" | "sort" | "order"> = {},
  ): Promise<T[]> {
    const pageSize = 100;
    const items: T[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const result = await this.client.listEntries<T>(apiId, {
        ...query,
        limit: pageSize,
        offset,
      });
      items.push(...result.items);
      if (result.items.length < pageSize || items.length >= result.total) break;
    }
    return items;
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

  async listProjects(): Promise<Project[]> {
    await this.ensureReady();
    const result = await this.client.listEntries<Project>("project", {
      status: "published",
      limit: 100,
    });
    return result.items;
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
      : (
          await this.client.listEntries<Workflow>("workflow", { limit: 100 })
        ).items.find((w) => relationSlug(w.fields.project) === slug) ?? null;
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
  }): Promise<{ project: Project; workflow: Workflow | null }> {
    await this.ensureReady();
    const existing = await this.listProjects();
    const slug = uniqueSlug(
      input.slug ?? input.name,
      new Set(existing.map((p) => p.slug)),
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
      const workflowSlug = `${slug}-default`;
      workflow = await this.client.createEntry<Workflow>("workflow", {
        slug: workflowSlug,
        status: "published",
        fields: {
          name: "Default",
          project: slug,
          stages_json: serializeWorkflowDocument(DEFAULT_WORKFLOW_DOCUMENT),
        },
      });
      await this.ensurePublished("workflow", workflow);
      project = await this.client.updateEntry<Project>("project", project.id, {
        fields: { default_workflow: workflow.slug },
      });
      await this.ensurePublished("project", project);
    }

    return { project, workflow };
  }

  async listWorkflows(projectSlug?: string): Promise<Workflow[]> {
    await this.ensureReady();
    const result = await this.client.listEntries<Workflow>("workflow", {
      status: "published",
      limit: 100,
    });
    if (!projectSlug) return result.items;
    return result.items.filter(
      (w) => relationSlug(w.fields.project) === projectSlug,
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
    const existing = await this.listWorkflows();
    const slug = uniqueSlug(
      input.slug ?? `${input.project}-${input.name}`,
      new Set(existing.map((w) => w.slug)),
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
    if (!workflow) throw new Error(`Workflow not found: ${slug}`);
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
    if (!workflow) throw new Error(`Workflow not found: ${slug}`);
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
    if (!result) throw new Error(`Workflow not found: ${slug}`);
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
    if (!workflow) throw new Error(`Workflow not found: ${slug}`);
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
    if (!workflow) throw new Error(`Workflow not found: ${slug}`);
    return this.client.listEntryVersions("workflow", workflow.id);
  }

  async restoreWorkflowVersion(slug: string, versionId: string) {
    await this.ensureReady();
    const workflow = await this.client.getEntryBySlug<Workflow>("workflow", slug);
    if (!workflow) throw new Error(`Workflow not found: ${slug}`);
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
    if (!result) throw new Error(`Workflow not found: ${slug}`);
    const editable = effectiveEditableDocument(result.workflow_document);
    return editable.ticket_templates ?? [];
  }

  async listTickets(input: {
    project: string;
    stage?: string;
    parent?: string | null;
  }): Promise<Ticket[]> {
    await this.ensureReady();
    const items = await this.listAllEntries<Ticket>("ticket", {
      status: "published",
    });
    return items
      .map((t) => this.normalizeTicketRelations(t))
      .filter((t) => t.fields.project === input.project)
      .filter((t) => (input.stage ? t.fields.stage === input.stage : true))
      .filter((t) => {
        if (input.parent === undefined) return true;
        const parent = t.fields.parent || null;
        if (input.parent === null || input.parent === "") {
          return parent == null || parent === "";
        }
        return parent === input.parent;
      })
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
    limit?: number;
    offset?: number;
  }): Promise<Paginated<SearchHit>> {
    await this.ensureReady();
    const project = await this.client.getEntryBySlug<Project>(
      "project",
      input.project,
    );
    if (!project) throw new Error(`Project not found: ${input.project}`);

    const tickets = await this.listTickets({ project: input.project });
    const comments = await this.listCommentsForTickets(
      tickets.map((t) => t.slug),
    );
    const commentsByTicket = new Map<string, Comment[]>();
    for (const comment of comments) {
      const key = relationSlug(comment.fields.ticket);
      if (!key) continue;
      const list = commentsByTicket.get(key) ?? [];
      list.push(comment);
      commentsByTicket.set(key, list);
    }

    const ticketInputs = tickets.map((t) => {
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
    });

    let wikiPages: Array<{
      slug: string;
      title: string;
      body?: string | null;
      updatedAt?: string | null;
    }> = [];
    if (input.includeWiki !== false) {
      wikiPages = (await this.listWikiPages({ project: input.project })).map(
        (p) => ({
          slug: p.slug,
          title: p.fields.title,
          body: p.fields.body ?? "",
          updatedAt: p.updatedAt,
        }),
      );
    }

    const hits = searchProjectContent({
      tickets: ticketInputs,
      wikiPages,
      filters: input.filters,
    });
    return paginateItems(hits, input.limit ?? 25, input.offset ?? 0);
  }

  async getProjectInsights(projectSlug: string): Promise<ProjectInsights> {
    const detail = await this.getProject(projectSlug);
    if (!detail) throw new Error(`Project not found: ${projectSlug}`);
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
      const all = (
        await this.client.listEntries<Ticket>("ticket", {
          status: "published",
          limit: 100,
        })
      ).items;
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
      (
        await this.client.listEntries<Ticket>("ticket", {
          status: "published",
          limit: 100,
        })
      ).items
        .filter((t) => t.fields.project === projectSlug)
        .map((t) => Number(t.fields.ticket_number))
        .filter((n) => Number.isFinite(n) && n > 0),
    );

    for (let attempt = 0; attempt < 12; attempt++) {
      const project = await this.client.getEntryBySlug<Project>(
        "project",
        projectSlug,
      );
      if (!project) throw new Error(`Project not found: ${projectSlug}`);

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

    throw new Error(
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
      : (
          await this.client.listEntries<Project>("project", {
            status: "published",
            limit: 100,
          })
        ).items;

    const allTickets = (
      await this.client.listEntries<Ticket>("ticket", {
        status: "published",
        limit: 100,
      })
    ).items;

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
    if (!projectCtx) throw new Error(`Project not found: ${input.project}`);

    const workflowSlug =
      input.workflow ??
      projectCtx.project.fields.default_workflow ??
      projectCtx.workflow?.slug;
    if (!workflowSlug) {
      throw new Error(`No workflow configured for project ${input.project}`);
    }

    const workflow =
      projectCtx.workflow?.slug === workflowSlug
        ? projectCtx.workflow
        : (await this.getWorkflow(workflowSlug))?.workflow;
    if (!workflow) throw new Error(`Workflow not found: ${workflowSlug}`);

    const doc = parseWorkflowDocument(workflow.fields.stages_json);
    const stages = doc.stages;
    const stage = input.stage ?? firstStageKey(stages);
    if (!stage) throw new Error("Workflow has no stages");

    const title = input.title?.trim() ?? "";
    if (!title) throw new Error("Ticket title is required");
    const description = (input.description ?? "").trim();
    if (!description) {
      throw new Error(
        "Ticket description is required (a short wish is enough for backlog)",
      );
    }

    // Backlog (first stage) accepts light wishes; playbook sections are
    // enforced when leaving backlog or when updating the description later.
    const intakeStage = firstStageKey(stages);
    if (stage !== intakeStage) {
      assertNoErrors(validateTicketDescription(description, doc.agent_policy));
    }

    const existing = (
      await this.client.listEntries<Ticket>("ticket", { limit: 100 })
    ).items;
    const slug = uniqueSlug(
      input.slug ?? input.title,
      new Set(existing.map((t) => t.slug)),
    );

    const parentSlug =
      input.parent !== undefined
        ? validateTicketParent({
            tickets: existing,
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
        sort_order: existing.filter((t) => t.fields.project === input.project)
          .length,
        ticket_key: identity.ticketKey,
        ticket_number: identity.ticketNumber,
        stage_entered_at: now,
        ...(parentSlug ? { parent: parentSlug } : {}),
      },
    });
    await this.ensurePublished("ticket", ticket);
    return ticket;
  }

  private async resolveTicket(slugOrKey: string): Promise<Ticket | null> {
    const found = await this.getTicket(slugOrKey);
    return found?.ticket ?? null;
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
    },
  ): Promise<Ticket> {
    await this.ensureReady();
    const ticket = await this.resolveTicket(slug);
    if (!ticket) throw new Error(`Ticket not found: ${slug}`);
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
      throw new Error("tokens_estimate must be a non-negative integer");
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
      const siblings = (
        await this.client.listEntries<Ticket>("ticket", {
          status: "published",
          limit: 100,
        })
      ).items;
      parentSlug = validateTicketParent({
        tickets: siblings,
        project: ticket.fields.project,
        selfSlug: ticket.slug,
        parentRef: input.parent,
      });
    }
    const updated = await this.client.updateEntry<Ticket>("ticket", ticket.id, {
      fields: {
        ...(input.title != null ? { title: input.title } : {}),
        ...(input.description != null ? { description: input.description } : {}),
        ...(input.priority != null ? { priority: input.priority } : {}),
        ...(input.tokens_estimate != null
          ? { tokens_estimate: input.tokens_estimate }
          : {}),
        ...(input.sort_order != null ? { sort_order: input.sort_order } : {}),
        ...(input.resolution != null ? { resolution: input.resolution } : {}),
        ...(parentSlug !== undefined ? { parent: parentSlug ?? "" } : {}),
      },
    });
    await this.ensurePublished("ticket", updated);
    return updated;
  }

  /**
   * Persist vertical board order for one project stage. Sets `sort_order` to
   * the index in `ordered_slugs` and returns only tickets whose order changed.
   */
  async reorderTickets(input: {
    project: string;
    stage: string;
    ordered_slugs: string[];
  }): Promise<Ticket[]> {
    await this.ensureReady();
    const projectTickets = await this.listTickets({ project: input.project });
    const updates = planTicketReorder({
      project: input.project,
      stage: input.stage,
      ordered_slugs: input.ordered_slugs,
      tickets: projectTickets.map((t) => ({
        slug: t.slug,
        project: t.fields.project,
        stage: t.fields.stage,
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
      /** Set only by the human-proxy API path (web session). */
      asHuman?: boolean;
    },
  ): Promise<Ticket> {
    await this.ensureReady();
    const ticket = await this.resolveTicket(slug);
    if (!ticket) throw new Error(`Ticket not found: ${slug}`);
    const workflow = await this.client.getEntryBySlug<Workflow>(
      "workflow",
      ticket.fields.workflow,
    );
    if (!workflow) throw new Error(`Workflow not found: ${ticket.fields.workflow}`);
    const doc = parseWorkflowDocument(workflow.fields.stages_json);
    const stages = doc.stages;
    if (!canTransition(stages, ticket.fields.stage, toStage)) {
      throw new Error(
        `Transition from "${ticket.fields.stage}" to "${toStage}" is not allowed`,
      );
    }
    const fromStage = stages.find((s) => s.key === ticket.fields.stage);
    const targetStage = stages.find((s) => s.key === toStage);
    if (!fromStage || !targetStage) {
      throw new Error("Invalid workflow stage for transition");
    }
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
    if (!ticket) throw new Error(`Ticket not found: ${slug}`);
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
    if (!workflow) throw new Error(`Workflow not found: ${ticket.fields.workflow}`);
    const stages = parseWorkflowDocument(workflow.fields.stages_json).stages;
    const stage = stages.find((s) => s.key === ticket.fields.stage);
    if (!stage) throw new Error("Invalid workflow stage for review verdict");
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
    const body = [
      "## Vorige stap",
      `Ticket stond in "${stage.name}" te wachten op beoordeling.`,
      "",
      "## Deze stap",
      verdict === "approved"
        ? `Goedgekeurd door ${author}${cascadeNote}. De agent mag dit ticket nu naar "${target ?? "de volgende stage"}" brengen.`
        : `Afgekeurd door ${author}${cascadeNote}. De agent brengt dit ticket terug naar "${target ?? "een eerdere stage"}".`,
      ...(input.comment?.trim()
        ? ["", verdict === "approved" ? "## Toelichting" : "## Reden", input.comment.trim()]
        : []),
    ].join("\n");
    await this.addComment({ ticket: ticket.slug, body, author });

    const updated = await this.client.updateEntry<Ticket>("ticket", ticket.id, {
      fields: {
        review_state: verdict,
        review_by: author,
        review_at: now,
      },
    });
    await this.ensurePublished("ticket", updated);
    return updated;
  }

  async addComment(input: {
    ticket: string;
    body: string;
    author?: string;
  }): Promise<Comment> {
    await this.ensureReady();
    const ticket = await this.resolveTicket(input.ticket);
    if (!ticket) throw new Error(`Ticket not found: ${input.ticket}`);
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
    return comment;
  }

  async listWikiPages(input: { project: string }): Promise<WikiPage[]> {
    await this.ensureReady();
    const project = await this.client.getEntryBySlug<Project>(
      "project",
      input.project,
    );
    if (!project) throw new Error(`Project not found: ${input.project}`);
    const result = await this.client.listEntries<WikiPage>(
      WIKI_PAGE_CONTENT_TYPE,
      { status: "published", limit: 100 },
    );
    return result.items
      .map((p) => this.normalizeWikiRelations(p))
      .filter((p) => p.fields.project === input.project)
      .sort((a, b) => {
        const so = (a.fields.sort_order ?? 0) - (b.fields.sort_order ?? 0);
        if (so !== 0) return so;
        return a.fields.title.localeCompare(b.fields.title);
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

  private async assertWikiParent(
    project: string,
    parentSlug: string | null | undefined,
    selfSlug?: string,
  ): Promise<void> {
    if (parentSlug == null || parentSlug === "") return;
    const all = (
      await this.client.listEntries<WikiPage>(WIKI_PAGE_CONTENT_TYPE, {
        limit: 100,
      })
    ).items.map((p) => this.normalizeWikiRelations(p));
    const bySlug = new Map(all.map((p) => [p.slug, p] as const));
    const parent = bySlug.get(parentSlug);
    if (!parent) throw new Error(`Parent wiki page not found: ${parentSlug}`);
    if (parent.fields.project !== project) {
      throw new Error(
        `Parent wiki page "${parentSlug}" belongs to a different project.`,
      );
    }
    if (selfSlug && parentSlug === selfSlug) {
      throw new Error("A wiki page cannot be its own parent.");
    }
    if (!selfSlug) return;
    const seen = new Set<string>([selfSlug]);
    let cursor: string | null = parentSlug;
    while (cursor) {
      if (seen.has(cursor)) {
        throw new Error(
          `Setting parent "${parentSlug}" would create a cycle in the wiki tree.`,
        );
      }
      seen.add(cursor);
      const ancestor = bySlug.get(cursor);
      cursor = relationSlug(ancestor?.fields.parent);
    }
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
    if (!title) throw new Error("title is required");
    const project = await this.client.getEntryBySlug<Project>(
      "project",
      input.project,
    );
    if (!project) throw new Error(`Project not found: ${input.project}`);
    await this.assertWikiParent(input.project, input.parent);
    const existing = (
      await this.client.listEntries<WikiPage>(WIKI_PAGE_CONTENT_TYPE, {
        limit: 100,
      })
    ).items;
    const slug =
      input.slug?.trim() ||
      uniqueSlug(title, new Set(existing.map((p) => p.slug)));
    if (existing.some((p) => p.slug === slug)) {
      throw new Error(`Wiki page slug already exists: ${slug}`);
    }
    const siblings = existing
      .map((p) => this.normalizeWikiRelations(p))
      .filter(
        (p) =>
          p.fields.project === input.project &&
          (p.fields.parent || null) === (input.parent || null),
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
          ...(input.parent ? { parent: input.parent } : {}),
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
    return page;
  }

  async updateWikiPage(
    slug: string,
    input: {
      title?: string;
      body?: string;
      parent?: string | null;
      sort_order?: number;
      updated_by?: string;
    },
  ): Promise<WikiPage> {
    await this.ensureReady();
    const page = await this.client.getEntryBySlug<WikiPage>(
      WIKI_PAGE_CONTENT_TYPE,
      slug,
    );
    if (!page) throw new Error(`Wiki page not found: ${slug}`);
    if (input.parent !== undefined) {
      await this.assertWikiParent(page.fields.project, input.parent, slug);
    }
    const updated = await this.client.updateEntry<WikiPage>(
      WIKI_PAGE_CONTENT_TYPE,
      page.id,
      {
        fields: {
          ...(input.title != null ? { title: input.title.trim() } : {}),
          ...(input.body != null ? { body: input.body } : {}),
          ...(input.parent !== undefined
            ? { parent: input.parent || "" }
            : {}),
          ...(input.sort_order != null ? { sort_order: input.sort_order } : {}),
          ...(input.updated_by != null
            ? { updated_by: input.updated_by }
            : {}),
        },
      },
    );
    await this.ensurePublished(WIKI_PAGE_CONTENT_TYPE, updated);
    return updated;
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
    if (!username) throw new Error("username is required");
    if (!input.password) throw new Error("password is required");
    const display_name = input.display_name.trim() || username;
    const existing = await this.listTraceaiUsers();
    if (
      existing.some(
        (u) => u.fields.username.trim().toLowerCase() === username.toLowerCase(),
      )
    ) {
      throw new Error(`User already exists: ${username}`);
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
    if (!user) throw new Error(`User not found: ${slug}`);

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
      throw new Error(
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
      throw new Error(
        `Missing project membership for role ${input.required} on ${input.projectSlug}`,
      );
    }
    const role = await this.getUserProjectRole(
      input.projectSlug,
      input.userSlug,
    );
    if (!roleAtLeast(role, input.required)) {
      throw new Error(
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
    if (!project || !user) throw new Error("project and user are required");
    if (!isProjectRole(input.role)) {
      throw new Error(`Invalid role: ${input.role}`);
    }
    const projectEntry = await this.client.getEntryBySlug<Project>(
      "project",
      project,
    );
    if (!projectEntry) throw new Error(`Project not found: ${project}`);
    const userEntry = await this.getTraceaiUser(user);
    if (!userEntry) throw new Error(`User not found: ${user}`);

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
