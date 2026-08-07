import {
  AuroraManagementClient,
  type AuroraClientConfig,
} from "./aurora.js";
import {
  DEFAULT_STAGES,
  DEFAULT_WORKFLOW_DOCUMENT,
  LAST_STAGE_VISIBLE_LIMIT,
  canTransition,
  deriveProjectKeyFromSlug,
  firstStageKey,
  formatTicketKey,
  isTicketArchived,
  isTicketKeyPattern,
  lastStageKey,
  normalizeProjectKey,
  parseWorkflowDocument,
  selectTicketsToArchive,
  serializeWorkflowDocument,
  slugify,
  validateTicketDescription,
  validateTransitionComment,
  type Comment,
  type Priority,
  type Project,
  type Ticket,
  type Workflow,
  type WorkflowAgentPolicy,
  type WorkflowDocument,
  type WorkflowStage,
} from "./types.js";

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
    const workflowSlug = project.fields.default_workflow;
    const workflow = workflowSlug
      ? await this.client.getEntryBySlug<Workflow>("workflow", workflowSlug)
      : (
          await this.client.listEntries<Workflow>("workflow", { limit: 100 })
        ).items.find((w) => w.fields.project === slug) ?? null;
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
    return result.items.filter((w) => w.fields.project === projectSlug);
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
        version: input.document.version ?? 2,
        agent_policy: input.document.agent_policy ?? current.agent_policy,
        stages: input.document.stages?.length
          ? input.document.stages
          : current.stages,
      };
    } else if (input.stages || input.agent_policy) {
      nextDoc = {
        version: 2,
        agent_policy: input.agent_policy ?? current.agent_policy,
        stages: input.stages ?? current.stages,
      };
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

  async listTickets(input: {
    project: string;
    stage?: string;
    include_archived?: boolean;
  }): Promise<Ticket[]> {
    await this.ensureReady();
    const result = await this.client.listEntries<Ticket>("ticket", {
      status: "published",
      limit: 100,
    });
    return result.items
      .filter((t) => t.fields.project === input.project)
      .filter((t) => (input.stage ? t.fields.stage === input.stage : true))
      .filter((t) => (input.include_archived ? true : !isTicketArchived(t)))
      .sort((a, b) => (a.fields.sort_order ?? 0) - (b.fields.sort_order ?? 0));
  }

  async getTicket(slugOrKey: string): Promise<{
    ticket: Ticket;
    comments: Comment[];
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
    const comments = (
      await this.client.listEntries<Comment>("comment", {
        status: "published",
        limit: 100,
      })
    ).items
      .filter((c) => c.fields.ticket === ticket!.slug)
      .sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
    return { ticket, comments };
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
      },
    });
    await this.ensurePublished("ticket", ticket);

    const last = lastStageKey(stages);
    if (last && stage === last) {
      await this.pruneLastStageTickets(input.project, workflowSlug, last);
    }

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
    const updated = await this.client.updateEntry<Ticket>("ticket", ticket.id, {
      fields: {
        ...(input.title != null ? { title: input.title } : {}),
        ...(input.description != null ? { description: input.description } : {}),
        ...(input.priority != null ? { priority: input.priority } : {}),
      },
    });
    await this.ensurePublished("ticket", updated);
    return updated;
  }

  async transitionTicket(
    slug: string,
    toStage: string,
    options?: {
      comment?: string;
      author?: string;
    },
  ): Promise<{ ticket: Ticket; archived: Ticket[] }> {
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
      validateTransitionComment({
        fromStage,
        toStage: targetStage,
        policy: doc.agent_policy,
        comment: options?.comment,
      }),
    );

    // Leaving intake (backlog) requires a refined, playbook-complete description.
    const intakeStage = firstStageKey(stages);
    if (fromStage.key === intakeStage && toStage !== intakeStage) {
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
    const updated = await this.client.updateEntry<Ticket>("ticket", ticket.id, {
      fields: { stage: toStage, stage_entered_at: now },
    });
    await this.ensurePublished("ticket", updated);

    let archived: Ticket[] = [];
    const last = lastStageKey(stages);
    if (last && toStage === last) {
      archived = await this.pruneLastStageTickets(
        updated.fields.project,
        updated.fields.workflow,
        last,
      );
    }

    return { ticket: updated, archived };
  }

  /**
   * Keep at most LAST_STAGE_VISIBLE_LIMIT non-archived tickets in the last
   * stage. Older tickets (by stage_entered_at) get archived_at set.
   */
  async pruneLastStageTickets(
    project: string,
    workflowSlug: string,
    lastStage: string,
    limit: number = LAST_STAGE_VISIBLE_LIMIT,
  ): Promise<Ticket[]> {
    await this.ensureReady();
    const result = await this.client.listEntries<Ticket>("ticket", {
      status: "published",
      limit: 100,
    });
    const inLastStage = result.items.filter(
      (t) =>
        t.fields.project === project &&
        t.fields.workflow === workflowSlug &&
        t.fields.stage === lastStage,
    );
    const toArchiveSlugs = new Set(
      selectTicketsToArchive(
        inLastStage.map((t) => ({
          slug: t.slug,
          stage_entered_at: t.fields.stage_entered_at,
          archived_at: t.fields.archived_at,
          updated_at: t.updatedAt,
        })),
        limit,
      ),
    );
    if (toArchiveSlugs.size === 0) return [];

    const now = new Date().toISOString();
    const archived: Ticket[] = [];
    for (const ticket of inLastStage) {
      if (!toArchiveSlugs.has(ticket.slug)) continue;
      const updated = await this.client.updateEntry<Ticket>("ticket", ticket.id, {
        fields: { archived_at: now },
      });
      await this.ensurePublished("ticket", updated);
      archived.push(updated);
    }
    return archived;
  }

  /**
   * Backfill stage_entered_at from updatedAt when missing, then prune each
   * workflow's last stage to LAST_STAGE_VISIBLE_LIMIT.
   */
  async backfillLastStageArchive(projectSlug?: string): Promise<{
    stageEnteredBackfilled: number;
    archived: number;
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

    let stageEnteredBackfilled = 0;
    for (const ticket of allTickets) {
      if (ticket.fields.stage_entered_at) continue;
      if (projectSlug && ticket.fields.project !== projectSlug) continue;
      const updated = await this.client.updateEntry<Ticket>("ticket", ticket.id, {
        fields: { stage_entered_at: ticket.updatedAt },
      });
      await this.ensurePublished("ticket", updated);
      stageEnteredBackfilled += 1;
    }

    let archived = 0;
    const touchedProjects: string[] = [];
    for (const project of projects) {
      const workflows = (
        await this.client.listEntries<Workflow>("workflow", {
          status: "published",
          limit: 100,
        })
      ).items.filter((w) => w.fields.project === project.slug);

      for (const workflow of workflows) {
        const last = lastStageKey(
          parseWorkflowDocument(workflow.fields.stages_json).stages,
        );
        if (!last) continue;
        const pruned = await this.pruneLastStageTickets(
          project.slug,
          workflow.slug,
          last,
        );
        if (pruned.length > 0) {
          archived += pruned.length;
          if (!touchedProjects.includes(project.slug)) {
            touchedProjects.push(project.slug);
          }
        }
      }
    }

    return {
      stageEnteredBackfilled,
      archived,
      projects: touchedProjects,
    };
  }

  async addComment(input: {
    ticket: string;
    body: string;
    author?: string;
  }): Promise<Comment> {
    await this.ensureReady();
    const ticket = await this.resolveTicket(input.ticket);
    if (!ticket) throw new Error(`Ticket not found: ${input.ticket}`);
    const existing = (
      await this.client.listEntries<Comment>("comment", { limit: 100 })
    ).items;
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

  private async ensurePublished(
    apiId: string,
    entry: { id: string; status: string },
  ) {
    // Always publish so public API reflects the latest fields after create/update.
    await this.client.publishEntry(apiId, entry.id);
  }
}
