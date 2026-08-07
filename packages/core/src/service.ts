import {
  AuroraManagementClient,
  type AuroraClientConfig,
} from "./aurora.js";
import {
  DEFAULT_STAGES,
  DEFAULT_WORKFLOW_DOCUMENT,
  canTransition,
  firstStageKey,
  parseWorkflowDocument,
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
  }): Promise<Ticket[]> {
    await this.ensureReady();
    const result = await this.client.listEntries<Ticket>("ticket", {
      status: "published",
      limit: 100,
    });
    return result.items
      .filter((t) => t.fields.project === input.project)
      .filter((t) => (input.stage ? t.fields.stage === input.stage : true))
      .sort((a, b) => (a.fields.sort_order ?? 0) - (b.fields.sort_order ?? 0));
  }

  async getTicket(slug: string): Promise<{
    ticket: Ticket;
    comments: Comment[];
  } | null> {
    await this.ensureReady();
    const ticket = await this.client.getEntryBySlug<Ticket>("ticket", slug);
    if (!ticket) return null;
    const comments = (
      await this.client.listEntries<Comment>("comment", {
        status: "published",
        limit: 100,
      })
    ).items
      .filter((c) => c.fields.ticket === slug)
      .sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
    return { ticket, comments };
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
      },
    });
    await this.ensurePublished("ticket", ticket);
    return ticket;
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
    const ticket = await this.client.getEntryBySlug<Ticket>("ticket", slug);
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
  ): Promise<Ticket> {
    await this.ensureReady();
    const ticket = await this.client.getEntryBySlug<Ticket>("ticket", slug);
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
        ticket: slug,
        body: options.comment,
        author: options.author ?? "agent",
      });
    }

    const updated = await this.client.updateEntry<Ticket>("ticket", ticket.id, {
      fields: { stage: toStage },
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
    const ticket = await this.client.getEntryBySlug<Ticket>("ticket", input.ticket);
    if (!ticket) throw new Error(`Ticket not found: ${input.ticket}`);
    const existing = (
      await this.client.listEntries<Comment>("comment", { limit: 100 })
    ).items;
    const slug = uniqueSlug(
      `${input.ticket}-comment`,
      new Set(existing.map((c) => c.slug)),
    );
    const comment = await this.client.createEntry<Comment>("comment", {
      slug,
      status: "published",
      fields: {
        ticket: input.ticket,
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
