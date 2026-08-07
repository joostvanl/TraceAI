export type Priority = "low" | "medium" | "high";

/** Per-stage instructions the agent must follow around this status. */
export type WorkflowStageAgentRules = {
  /** Short purpose of this stage */
  purpose?: string;
  /** What the agent must do / write when entering this stage */
  on_enter?: string[];
  /** What the agent must do / write when leaving this stage */
  on_exit?: string[];
  /** Require a transition comment when entering this stage */
  require_comment_on_enter?: boolean;
  /** Require a transition comment when leaving this stage */
  require_comment_on_exit?: boolean;
  /**
   * When entering this stage, the comment must include these Markdown headings
   * (case-insensitive), e.g. ["## Testverslag", "## Uitslag"].
   */
  require_comment_sections_on_enter?: string[];
  /** Suggested comment skeleton shown to agents */
  comment_template?: string;
};

export type WorkflowStage = {
  key: string;
  name: string;
  transitions: string[];
  agent?: WorkflowStageAgentRules;
};

/** Global TraceAI working agreements for a workflow. */
export type WorkflowAgentPolicy = {
  /** Always shown to agents via get_project / get_workflow / MCP */
  summary: string;
  /** Rules for writing ticket descriptions */
  ticket_description: string[];
  /** Rules that apply on every workflow transition */
  on_every_transition: string[];
  /** Minimum description length (characters) when creating/updating tickets */
  min_description_chars?: number;
  /** Require Markdown ## headings in new ticket descriptions */
  require_description_headings?: string[];
};

export type WorkflowDocument = {
  version: number;
  agent_policy: WorkflowAgentPolicy;
  stages: WorkflowStage[];
};

export type AuroraEntry<TFields extends Record<string, unknown> = Record<string, unknown>> = {
  id: string;
  slug: string;
  contentType: string;
  status: "draft" | "published";
  locale: string;
  fields: TFields;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectFields = {
  name: string;
  description?: string;
  default_workflow?: string;
  /** Short uppercase project prefix for ticket keys, e.g. TRA */
  project_key?: string;
  /** Next number to allocate for this project (1-based). */
  next_ticket_number?: number;
};

export type WorkflowFields = {
  name: string;
  project: string;
  stages_json: string;
};

export type TicketFields = {
  title: string;
  description?: string;
  project: string;
  workflow: string;
  stage: string;
  priority?: string;
  created_by?: string;
  sort_order?: number;
  /** Immutable display key, e.g. TRA-42 */
  ticket_key?: string;
  /** Numeric portion of ticket_key within the project */
  ticket_number?: number;
  /** ISO datetime when the ticket entered its current stage */
  stage_entered_at?: string;
  /** ISO datetime when auto-archived off the board; unset = visible */
  archived_at?: string;
};

/** Max visible tickets in the last workflow stage column. */
export const LAST_STAGE_VISIBLE_LIMIT = 20;

export type CommentFields = {
  ticket: string;
  body: string;
  author?: string;
};

export type Project = AuroraEntry<ProjectFields>;
export type Workflow = AuroraEntry<WorkflowFields>;
export type Ticket = AuroraEntry<TicketFields>;
export type Comment = AuroraEntry<CommentFields>;

export type ListResult<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
};

export const DEFAULT_AGENT_POLICY: WorkflowAgentPolicy = {
  summary:
    "TraceAI tickets must be self-contained for junior agents. Every workflow transition needs a Markdown comment describing completed work. Entering review always requires a short test report with results.",
  ticket_description: [
    "Write descriptions that a junior agent with no chat history can execute alone.",
    "Include: Context, Goal, What to implement (concrete steps), Out of scope, Acceptance criteria.",
    "Use Markdown headings (##) for those sections.",
    "Link related ticket slugs when there are dependencies.",
    "Never leave only a one-line title-as-description.",
  ],
  on_every_transition: [
    "Before changing stage, post a Markdown comment on the ticket.",
    "Start with '## Vorige stap' describing what was true / done in the stage you leave.",
    "Continue with '## Deze stap' describing what you completed and what the next stage should verify.",
    "List concrete artifacts (files, endpoints, commands) when relevant.",
  ],
  min_description_chars: 280,
  require_description_headings: [
    "## Context",
    "## Goal",
    "## What to implement",
    "## Acceptance criteria",
  ],
};

export const DEFAULT_STAGES: WorkflowStage[] = [
  {
    key: "backlog",
    name: "Backlog",
    transitions: ["todo"],
    agent: {
      purpose: "Parked ideas / not yet ready to pull.",
      on_exit: [
        "Confirm the description is complete enough for a junior agent.",
        "Add a comment summarizing why it is ready to pull into To do.",
      ],
      require_comment_on_exit: true,
    },
  },
  {
    key: "todo",
    name: "To do",
    transitions: ["in_progress", "backlog"],
    agent: {
      purpose: "Ready to start; next up for an agent.",
      on_enter: ["Confirm dependencies are clear in the description."],
      on_exit: [
        "Comment what you will implement first when moving to In progress.",
      ],
      require_comment_on_exit: true,
    },
  },
  {
    key: "in_progress",
    name: "In progress",
    transitions: ["review", "todo"],
    agent: {
      purpose: "Active implementation.",
      on_exit: [
        "Comment what was implemented (files, APIs, behaviour).",
        "If moving to Review, include a short test report (see review stage rules).",
      ],
      require_comment_on_exit: true,
      comment_template:
        "## Vorige stap\n...\n\n## Deze stap\n...\n\n## Testverslag\n- Test: ...\n- Resultaat: PASS/FAIL\n\n## Uitslag\nPASS|FAIL",
    },
  },
  {
    key: "review",
    name: "Review",
    transitions: ["done", "in_progress"],
    agent: {
      purpose: "Verification before Done.",
      on_enter: [
        "Transition comment MUST include a short test report.",
        "List each test/check run and PASS/FAIL.",
        "Include overall ## Uitslag PASS or FAIL.",
      ],
      require_comment_on_enter: true,
      require_comment_sections_on_enter: ["## Testverslag", "## Uitslag"],
      on_exit: [
        "If returning to In progress, comment what failed and what to fix.",
        "If moving to Done, confirm acceptance criteria are met.",
      ],
      require_comment_on_exit: true,
      comment_template:
        "## Vorige stap\nImplementation completed: ...\n\n## Deze stap\nReady for review.\n\n## Testverslag\n- `pnpm --filter @traceai/api build` — PASS\n- Manual check: ... — PASS\n\n## Uitslag\nPASS",
    },
  },
  {
    key: "done",
    name: "Done",
    transitions: [],
    agent: {
      purpose: "Accepted and finished.",
      on_enter: ["Comment final confirmation that acceptance criteria are met."],
      require_comment_on_enter: true,
    },
  },
];

export const DEFAULT_WORKFLOW_DOCUMENT: WorkflowDocument = {
  version: 2,
  agent_policy: DEFAULT_AGENT_POLICY,
  stages: DEFAULT_STAGES,
};

function parseStageAgent(raw: unknown): WorkflowStageAgentRules | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as Record<string, unknown>;
  return {
    purpose: item.purpose != null ? String(item.purpose) : undefined,
    on_enter: Array.isArray(item.on_enter)
      ? item.on_enter.map((s) => String(s))
      : undefined,
    on_exit: Array.isArray(item.on_exit)
      ? item.on_exit.map((s) => String(s))
      : undefined,
    require_comment_on_enter:
      typeof item.require_comment_on_enter === "boolean"
        ? item.require_comment_on_enter
        : undefined,
    require_comment_on_exit:
      typeof item.require_comment_on_exit === "boolean"
        ? item.require_comment_on_exit
        : undefined,
    require_comment_sections_on_enter: Array.isArray(
      item.require_comment_sections_on_enter,
    )
      ? item.require_comment_sections_on_enter.map((s) => String(s))
      : undefined,
    comment_template:
      item.comment_template != null ? String(item.comment_template) : undefined,
  };
}

function defaultAgentForStage(key: string): WorkflowStageAgentRules | undefined {
  return DEFAULT_STAGES.find((s) => s.key === key)?.agent;
}

function parseStageList(raw: unknown): WorkflowStage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => {
      const key = String(item.key ?? "");
      return {
        key,
        name: String(item.name ?? item.key ?? ""),
        transitions: Array.isArray(item.transitions)
          ? item.transitions.map((t) => String(t))
          : [],
        agent: parseStageAgent(item.agent) ?? defaultAgentForStage(key),
      };
    })
    .filter((stage) => stage.key.length > 0);
}

function parseAgentPolicy(raw: unknown): WorkflowAgentPolicy {
  if (!raw || typeof raw !== "object") return DEFAULT_AGENT_POLICY;
  const item = raw as Record<string, unknown>;
  return {
    summary:
      item.summary != null
        ? String(item.summary)
        : DEFAULT_AGENT_POLICY.summary,
    ticket_description: Array.isArray(item.ticket_description)
      ? item.ticket_description.map((s) => String(s))
      : DEFAULT_AGENT_POLICY.ticket_description,
    on_every_transition: Array.isArray(item.on_every_transition)
      ? item.on_every_transition.map((s) => String(s))
      : DEFAULT_AGENT_POLICY.on_every_transition,
    min_description_chars:
      typeof item.min_description_chars === "number"
        ? item.min_description_chars
        : DEFAULT_AGENT_POLICY.min_description_chars,
    require_description_headings: Array.isArray(item.require_description_headings)
      ? item.require_description_headings.map((s) => String(s))
      : DEFAULT_AGENT_POLICY.require_description_headings,
  };
}

/**
 * Parses workflow `stages_json`.
 * Supports legacy array-of-stages OR document `{ version, agent_policy, stages }`.
 */
export function parseWorkflowDocument(
  stagesJson: string | undefined | null,
): WorkflowDocument {
  if (!stagesJson?.trim()) {
    return { ...DEFAULT_WORKFLOW_DOCUMENT };
  }
  try {
    const parsed = JSON.parse(stagesJson) as unknown;
    if (Array.isArray(parsed)) {
      return {
        version: 1,
        agent_policy: DEFAULT_AGENT_POLICY,
        stages: parseStageList(parsed),
      };
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const stages = parseStageList(obj.stages ?? obj);
      return {
        version: typeof obj.version === "number" ? obj.version : 2,
        agent_policy: parseAgentPolicy(obj.agent_policy),
        stages: stages.length ? stages : DEFAULT_STAGES,
      };
    }
  } catch {
    // fall through
  }
  return { ...DEFAULT_WORKFLOW_DOCUMENT };
}

/** @deprecated Prefer parseWorkflowDocument — kept for board UI stage lists */
export function parseStages(stagesJson: string | undefined | null): WorkflowStage[] {
  return parseWorkflowDocument(stagesJson).stages;
}

export function serializeWorkflowDocument(doc: WorkflowDocument): string {
  return JSON.stringify(doc, null, 2);
}

/** @deprecated Prefer serializeWorkflowDocument */
export function serializeStages(stages: WorkflowStage[]): string {
  return serializeWorkflowDocument({
    version: 2,
    agent_policy: DEFAULT_AGENT_POLICY,
    stages,
  });
}

export function canTransition(
  stages: WorkflowStage[],
  fromKey: string,
  toKey: string,
): boolean {
  const from = stages.find((s) => s.key === fromKey);
  if (!from) return false;
  return from.transitions.includes(toKey);
}

export function firstStageKey(stages: WorkflowStage[]): string | null {
  return stages[0]?.key ?? null;
}

/** Last stage in the workflow definition (typically Done). */
export function lastStageKey(stages: WorkflowStage[]): string | null {
  return stages[stages.length - 1]?.key ?? null;
}

export type ArchiveCandidate = {
  slug: string;
  stage_entered_at?: string | null;
  archived_at?: string | null;
  /** Fallback when stage_entered_at is missing (e.g. legacy tickets). */
  updated_at?: string | null;
};

/**
 * Among non-archived candidates, return the slugs that exceed `limit`
 * when sorted by most recent stage entry first (those should be archived).
 */
export function selectTicketsToArchive(
  candidates: ArchiveCandidate[],
  limit: number = LAST_STAGE_VISIBLE_LIMIT,
): string[] {
  const active = candidates.filter((c) => !c.archived_at);
  const enteredAt = (c: ArchiveCandidate) =>
    new Date(c.stage_entered_at || c.updated_at || 0).getTime();
  const newestFirst = [...active].sort((a, b) => enteredAt(b) - enteredAt(a));
  return newestFirst.slice(limit).map((c) => c.slug);
}

export function isTicketArchived(
  ticket: { fields: { archived_at?: string | null } },
): boolean {
  return Boolean(ticket.fields.archived_at);
}

function normalizeHeading(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function validateTicketDescription(
  description: string | undefined | null,
  policy: WorkflowAgentPolicy,
): string[] {
  const errors: string[] = [];
  const text = description ?? "";
  const min = policy.min_description_chars ?? 0;
  if (text.trim().length < min) {
    errors.push(
      `Ticket description must be at least ${min} characters so junior agents have full context (got ${text.trim().length}).`,
    );
  }
  for (const heading of policy.require_description_headings ?? []) {
    if (!normalizeHeading(text).includes(normalizeHeading(heading))) {
      errors.push(
        `Ticket description must include Markdown heading "${heading}".`,
      );
    }
  }
  return errors;
}

export function validateTransitionComment(input: {
  fromStage: WorkflowStage;
  toStage: WorkflowStage;
  policy: WorkflowAgentPolicy;
  comment?: string | null;
}): string[] {
  const errors: string[] = [];
  const comment = input.comment?.trim() ?? "";
  const needsComment =
    input.fromStage.agent?.require_comment_on_exit === true ||
    input.toStage.agent?.require_comment_on_enter === true ||
    (input.policy.on_every_transition?.length ?? 0) > 0;

  if (needsComment && comment.length < 40) {
    errors.push(
      "A Markdown transition comment is required (min ~40 chars) describing the previous step and what you completed. See workflow agent_policy.on_every_transition.",
    );
  }

  if (comment) {
    if (!normalizeHeading(comment).includes("## vorige stap")) {
      errors.push(
        'Transition comment must include heading "## Vorige stap" explaining work done in the stage you leave.',
      );
    }
    if (!normalizeHeading(comment).includes("## deze stap")) {
      errors.push(
        'Transition comment must include heading "## Deze stap" describing what you completed and what the next stage should verify.',
      );
    }
  }

  const requiredSections =
    input.toStage.agent?.require_comment_sections_on_enter ?? [];
  for (const section of requiredSections) {
    if (!normalizeHeading(comment).includes(normalizeHeading(section))) {
      errors.push(
        `Entering "${input.toStage.key}" requires comment section "${section}".`,
      );
    }
  }

  return errors;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

/** Jira-style project prefix: 2–10 uppercase A–Z / 0–9. */
export function normalizeProjectKey(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const key = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (key.length < 2 || key.length > 10) return null;
  return key;
}

/**
 * Deterministic default when project_key is unset.
 * Prefer first 3 letters of alphabetic slug chars; special-case known projects.
 */
export function deriveProjectKeyFromSlug(slug: string): string {
  const known: Record<string, string> = { traceai: "TRA" };
  if (known[slug]) return known[slug];
  const letters = slug.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const key = (letters.slice(0, 3) || "PRJ").padEnd(2, "X");
  return key.slice(0, 10);
}

export function formatTicketKey(projectKey: string, ticketNumber: number): string {
  return `${projectKey}-${ticketNumber}`;
}

/** Matches TRA-42 style keys (not kebab slugs). */
export function isTicketKeyPattern(value: string): boolean {
  return /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(value.trim().toUpperCase());
}
