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
  /**
   * When leaving this stage for another stage, the comment must include these
   * Markdown headings (case-insensitive), e.g. ["## Wiki"].
   */
  require_comment_sections_on_exit?: string[];
  /** Suggested comment skeleton shown to agents */
  comment_template?: string;
  /**
   * When leaving this stage for another stage, the transition must include
   * tokens_estimate (LLM token estimate for the whole ticket).
   */
  require_tokens_estimate_on_exit?: boolean;
  /**
   * When entering this stage, the transition must include a resolution
   * (closure reason) from TICKET_RESOLUTIONS.
   */
  require_resolution_on_enter?: boolean;
  /**
   * When true, this stage can only be left after a human recorded a review
   * verdict in the UI. The human never moves the ticket: the agent performs
   * the transition afterwards, towards the stage that matches the verdict.
   */
  require_human_approval_on_exit?: boolean;
  /**
   * Target stage for an "approved" verdict. Defaults to the first transition
   * that is not listed in human_reject_to.
   */
  human_approve_to?: string;
  /**
   * Target stage key(s) for a "rejected" verdict. Reject transitions must
   * include a "## Reden" section.
   */
  human_reject_to?: string[];
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
  /**
   * When true, every transition must include tokens_used (non-negative integer
   * delta for that step). Accumulated into ticket tokens_actual.
   */
  require_tokens_used_on_transition?: boolean;
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
  /** LLM token estimate for the whole ticket (set at refinement). */
  tokens_estimate?: number;
  /** Cumulative self-reported LLM tokens used across transitions. */
  tokens_actual?: number;
  /** Closure reason when entering a resolution-required stage. */
  resolution?: TicketResolution;
  /**
   * Human verdict on the current human-gated stage. Cleared on every stage
   * change, so each review round needs its own verdict.
   */
  review_state?: TicketReviewState | "";
  /** Name of the human who recorded the current verdict. */
  review_by?: string;
  /** ISO datetime of the current verdict. */
  review_at?: string;
};

export const TICKET_RESOLUTIONS = [
  "completed",
  "superseded",
  "cancelled",
  "duplicate",
  "verification-only",
] as const;

export type TicketResolution = (typeof TICKET_RESOLUTIONS)[number];

export function isTicketResolution(value: unknown): value is TicketResolution {
  return (
    typeof value === "string" &&
    (TICKET_RESOLUTIONS as readonly string[]).includes(value)
  );
}

export const TICKET_REVIEW_STATES = ["approved", "rejected"] as const;

/** Human verdict on a review; the agent transitions on the back of it. */
export type TicketReviewState = (typeof TICKET_REVIEW_STATES)[number];

export function isTicketReviewState(value: unknown): value is TicketReviewState {
  return (
    typeof value === "string" &&
    (TICKET_REVIEW_STATES as readonly string[]).includes(value)
  );
}

/**
 * Written on every stage change. Only the verdict itself is cleared: reviewer
 * and timestamp stay behind as the record of the last verdict, and are read
 * only while a verdict is active.
 */
export const CLEARED_REVIEW_FIELDS = {
  review_state: "",
} as const;

/** Max visible tickets in the last workflow stage column. */
export const LAST_STAGE_VISIBLE_LIMIT = 20;

export type CommentFields = {
  ticket: string;
  body: string;
  author?: string;
};

/** Per-project hierarchical Markdown wiki page (Aurora content type `wiki_page`). */
export type WikiPageFields = {
  title: string;
  body?: string;
  /** Project slug */
  project: string;
  /** Parent wiki page slug; omit/empty for root */
  parent?: string | null;
  sort_order?: number;
  updated_by?: string;
};

/**
 * Shared TraceAI web UI login. Stored as Aurora content type `app_login`
 * (entry slug `default`) with Aurora field types `username` + `password`.
 *
 * On read, `password` is never plaintext/hash — only `{ set: true }` or `null`.
 * Verify via Aurora management `POST .../verify-credentials`.
 */
export type AppLoginPasswordMarker = { set: true };

export type AppLoginFields = {
  username: string;
  password: AppLoginPasswordMarker | null;
};

export type Project = AuroraEntry<ProjectFields>;
export type Workflow = AuroraEntry<WorkflowFields>;
export type Ticket = AuroraEntry<TicketFields>;
export type Comment = AuroraEntry<CommentFields>;
export type WikiPage = AuroraEntry<WikiPageFields>;
export type AppLogin = AuroraEntry<AppLoginFields>;

export const APP_LOGIN_CONTENT_TYPE = "app_login";
export const APP_LOGIN_ENTRY_SLUG = "default";
export const WIKI_PAGE_CONTENT_TYPE = "wiki_page";

export type ListResult<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
};

export const DEFAULT_AGENT_POLICY: WorkflowAgentPolicy = {
  summary:
    "TraceAI tickets must be self-contained for junior agents. Every workflow transition needs a Markdown comment describing completed work, plus tokens_used (self-reported LLM token delta for that step). Entering review always requires a short test report with results.",
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
    "Pass tokens_used: a non-negative integer estimate of LLM tokens (prompt+completion) spent on this step.",
    "Stages with require_human_approval_on_exit need a human verdict (Goedkeuren/Afkeuren in the UI) before the agent may transition out.",
  ],
  min_description_chars: 280,
  require_description_headings: [
    "## Context",
    "## Goal",
    "## What to implement",
    "## Acceptance criteria",
  ],
  require_tokens_used_on_transition: true,
};

export const DEFAULT_STAGES: WorkflowStage[] = [
  {
    key: "backlog",
    name: "Backlog",
    transitions: ["in_refinement"],
    agent: {
      purpose: "Parked ideas / not yet ready to refine.",
      on_exit: [
        "Confirm the wish is clear enough to refine into a junior-agent playbook.",
        "Add a comment summarizing why it is ready for In Refinement.",
      ],
      require_comment_on_exit: true,
    },
  },
  {
    key: "in_refinement",
    name: "In Refinement",
    transitions: ["todo", "backlog"],
    agent: {
      purpose: "Description is being sharpened into an executable playbook.",
      on_enter: [
        "Confirm the ticket is ready to be rewritten with Context/Goal/What to implement/Acceptance criteria.",
      ],
      on_exit: [
        "When moving to To do, confirm the description is complete enough for a junior agent.",
        "When returning to Backlog, explain why refinement stopped.",
        "Pass tokens_estimate when leaving to To do.",
      ],
      require_comment_on_exit: true,
      require_tokens_estimate_on_exit: true,
    },
  },
  {
    key: "todo",
    name: "To do",
    transitions: ["in_progress", "backlog", "in_refinement"],
    agent: {
      purpose: "Ready to start; next up for an agent.",
      on_enter: ["Confirm dependencies are clear in the description."],
      on_exit: [
        "When moving to In progress, describe the first implementation step and confirm that work can start.",
        "When returning to Backlog or In Refinement, explain why the ticket is no longer ready.",
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
    transitions: ["done", "todo"],
    agent: {
      purpose:
        "Verification before Done — a human verdict is required before the agent may move on.",
      on_enter: [
        "Transition comment MUST include a short test report.",
        "List each test/check run and PASS/FAIL.",
        "Include overall ## Uitslag PASS or FAIL.",
      ],
      require_comment_on_enter: true,
      require_comment_sections_on_enter: ["## Testverslag", "## Uitslag"],
      on_exit: [
        "Wait for the human verdict (Goedkeuren/Afkeuren in the UI); only then transition.",
        "If the verdict is rejected, move to To do and reference the reason (## Reden).",
        "If the verdict is approved, move to Done, confirm acceptance criteria are met and include ## Wiki.",
      ],
      require_comment_on_exit: true,
      require_human_approval_on_exit: true,
      human_approve_to: "done",
      human_reject_to: ["todo"],
      comment_template:
        "## Vorige stap\nImplementation completed: ...\n\n## Deze stap\nReady for review.\n\n## Testverslag\n- `pnpm --filter @traceai/api build` — PASS\n- Manual check: ... — PASS\n\n## Uitslag\nPASS",
    },
  },
  {
    key: "done",
    name: "Done",
    transitions: ["todo"],
    agent: {
      purpose: "Closed with an explicit resolution and supporting evidence or rationale.",
      on_enter: [
        "For resolution completed: confirm every acceptance criterion separately and ## Uitslag PASS.",
        "For other resolutions: document the reason and why unmet criteria are acceptable.",
        "Pass resolution: completed | superseded | cancelled | duplicate | verification-only.",
        "Include ## Wiki with page slug(s) or N/A + reason.",
      ],
      on_exit: [
        "Reopening is only for tickets that turn out to be incomplete; explain what was missed and what will be picked up again.",
      ],
      require_comment_on_enter: true,
      require_comment_on_exit: true,
      require_comment_sections_on_enter: ["## Wiki"],
      require_resolution_on_enter: true,
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
    require_comment_sections_on_exit: Array.isArray(
      item.require_comment_sections_on_exit,
    )
      ? item.require_comment_sections_on_exit.map((s) => String(s))
      : undefined,
    comment_template:
      item.comment_template != null ? String(item.comment_template) : undefined,
    require_tokens_estimate_on_exit:
      typeof item.require_tokens_estimate_on_exit === "boolean"
        ? item.require_tokens_estimate_on_exit
        : undefined,
    require_resolution_on_enter:
      typeof item.require_resolution_on_enter === "boolean"
        ? item.require_resolution_on_enter
        : undefined,
    require_human_approval_on_exit:
      typeof item.require_human_approval_on_exit === "boolean"
        ? item.require_human_approval_on_exit
        : undefined,
    human_approve_to:
      item.human_approve_to != null && String(item.human_approve_to).trim()
        ? String(item.human_approve_to).trim()
        : undefined,
    human_reject_to: Array.isArray(item.human_reject_to)
      ? item.human_reject_to.map((s) => String(s))
      : undefined,
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
    // Do not fall back to DEFAULT — missing means "not required" (compat).
    require_tokens_used_on_transition:
      typeof item.require_tokens_used_on_transition === "boolean"
        ? item.require_tokens_used_on_transition
        : undefined,
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

/** Stage key for playbook refinement (defaults to `in_refinement` when present). */
export function refinementStageKey(stages: WorkflowStage[]): string | null {
  if (stages.some((s) => s.key === "in_refinement")) return "in_refinement";
  return null;
}

/**
 * Approve target for a human-gated stage. Prefer explicit `human_approve_to`,
 * otherwise the first transition not listed in `human_reject_to`.
 */
export function humanApproveTarget(stage: WorkflowStage): string | null {
  const explicit = stage.agent?.human_approve_to?.trim();
  if (explicit && stage.transitions.includes(explicit)) return explicit;
  const rejects = new Set(stage.agent?.human_reject_to ?? []);
  return stage.transitions.find((t) => !rejects.has(t)) ?? null;
}

/** Reject target(s) for a human-gated stage. */
export function humanRejectTargets(stage: WorkflowStage): string[] {
  const configured = stage.agent?.human_reject_to ?? [];
  const valid = configured.filter((t) => stage.transitions.includes(t));
  if (valid.length) return valid;
  const approve = humanApproveTarget(stage);
  return stage.transitions.filter((t) => t !== approve);
}

/**
 * Where a human verdict may take a gated stage. `null` outside a gate.
 */
export function reviewVerdictTarget(
  stage: WorkflowStage,
  verdict: TicketReviewState,
): string | null {
  if (stage.agent?.require_human_approval_on_exit !== true) return null;
  if (verdict === "approved") return humanApproveTarget(stage);
  return humanRejectTargets(stage)[0] ?? null;
}

/**
 * Enforce human-approval gates. A gated stage may only be left once a human
 * recorded a verdict, and only towards the stage that matches that verdict.
 * The human-proxy path (`asHuman`) stays open as a manual override.
 */
export function validateHumanGateExit(input: {
  fromStage: WorkflowStage;
  toStage: WorkflowStage;
  asHuman?: boolean;
  comment?: string | null;
  /** Verdict currently recorded on the ticket, if any. */
  reviewState?: string | null;
}): string[] {
  const errors: string[] = [];
  if (input.fromStage.key === input.toStage.key) return errors;
  if (input.fromStage.agent?.require_human_approval_on_exit !== true) {
    return errors;
  }

  const rejects = humanRejectTargets(input.fromStage);
  const rejecting = rejects.includes(input.toStage.key);

  if (!input.asHuman) {
    const verdict = input.reviewState?.trim();
    if (!isTicketReviewState(verdict)) {
      errors.push(
        `Stage "${input.fromStage.key}" is waiting for a human review verdict. Ask the reviewer to use Goedkeuren/Afkeuren in the TraceAI UI, then transition on the back of that verdict.`,
      );
      return errors;
    }
    const allowed = reviewVerdictTarget(input.fromStage, verdict);
    if (allowed !== input.toStage.key) {
      errors.push(
        `The human verdict on "${input.fromStage.key}" is "${verdict}", so this ticket may only move to "${allowed ?? "(no target configured)"}" — not "${input.toStage.key}".`,
      );
      return errors;
    }
  }

  if (rejecting) {
    const comment = input.comment?.trim() ?? "";
    if (!normalizeHeading(comment).includes("## reden")) {
      errors.push(
        `Rejecting from "${input.fromStage.key}" requires comment section "## Reden" with the rejection reason.`,
      );
    }
  }
  return errors;
}

/**
 * Whether a human verdict may be recorded, and on which stage. Used by the
 * API before writing a verdict and by the UI to decide what to render.
 */
export function validateReviewVerdict(input: {
  stage: WorkflowStage;
  verdict: string;
  comment?: string | null;
}): string[] {
  const errors: string[] = [];
  if (input.stage.agent?.require_human_approval_on_exit !== true) {
    errors.push(
      `Stage "${input.stage.key}" does not ask for a human review verdict.`,
    );
    return errors;
  }
  if (!isTicketReviewState(input.verdict)) {
    errors.push(
      `verdict must be one of: ${TICKET_REVIEW_STATES.join(", ")}.`,
    );
    return errors;
  }
  if (input.verdict === "rejected" && !input.comment?.trim()) {
    errors.push("Rejecting a review requires a reason.");
  }
  return errors;
}

/** Last stage in the workflow definition (typically Done). */
export function lastStageKey(stages: WorkflowStage[]): string | null {
  return stages[stages.length - 1]?.key ?? null;
}

/**
 * Newest-first, capped for display. Purely a view concern: items beyond the
 * limit keep their stage and stay retrievable, they are just not shown.
 */
export function newestFirstCapped<T>(
  items: T[],
  enteredAt: (item: T) => string | null | undefined,
  limit: number = LAST_STAGE_VISIBLE_LIMIT,
): T[] {
  const time = (item: T) => new Date(enteredAt(item) ?? 0).getTime();
  return [...items].sort((a, b) => time(b) - time(a)).slice(0, limit);
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

  if (input.fromStage.key !== input.toStage.key) {
    const exitSections =
      input.fromStage.agent?.require_comment_sections_on_exit ?? [];
    for (const section of exitSections) {
      if (!normalizeHeading(comment).includes(normalizeHeading(section))) {
        errors.push(
          `Leaving "${input.fromStage.key}" requires comment section "${section}".`,
        );
      }
    }
  }

  return errors;
}

/**
 * Validate optional LLM token fields against workflow playbook flags.
 * Does not hard-code stage keys — only reads require_* flags.
 */
export function validateTransitionTokens(input: {
  fromStage: WorkflowStage;
  toStage: WorkflowStage;
  policy: WorkflowAgentPolicy;
  tokens_estimate?: number | null;
  tokens_used?: number | null;
}): string[] {
  const errors: string[] = [];
  const leavingMarkedStage =
    input.fromStage.key !== input.toStage.key &&
    input.fromStage.agent?.require_tokens_estimate_on_exit === true;

  if (leavingMarkedStage) {
    const estimateErrors = validateTokenCount(
      input.tokens_estimate,
      "tokens_estimate",
    );
    if (estimateErrors.length) {
      errors.push(
        ...estimateErrors.map(
          (e) =>
            `${e} Required when leaving stage "${input.fromStage.key}" (require_tokens_estimate_on_exit).`,
        ),
      );
    }
  } else if (
    input.tokens_estimate != null &&
    input.tokens_estimate !== undefined
  ) {
    errors.push(...validateTokenCount(input.tokens_estimate, "tokens_estimate"));
  }

  if (input.policy.require_tokens_used_on_transition === true) {
    const usedErrors = validateTokenCount(input.tokens_used, "tokens_used");
    if (usedErrors.length) {
      errors.push(
        ...usedErrors.map(
          (e) =>
            `${e} Required on every transition (agent_policy.require_tokens_used_on_transition).`,
        ),
      );
    }
  } else if (input.tokens_used != null && input.tokens_used !== undefined) {
    errors.push(...validateTokenCount(input.tokens_used, "tokens_used"));
  }

  return errors;
}

/**
 * Validate resolution against workflow playbook flags.
 * Does not hard-code stage keys — only reads require_resolution_on_enter.
 */
export function validateTransitionResolution(input: {
  fromStage: WorkflowStage;
  toStage: WorkflowStage;
  resolution?: string | null;
}): string[] {
  const errors: string[] = [];
  const required =
    input.fromStage.key !== input.toStage.key &&
    input.toStage.agent?.require_resolution_on_enter === true;

  if (!required) {
    if (input.resolution != null && input.resolution !== "") {
      if (!isTicketResolution(input.resolution)) {
        errors.push(
          `resolution must be one of: ${TICKET_RESOLUTIONS.join(", ")}.`,
        );
      }
    }
    return errors;
  }

  if (input.resolution == null || input.resolution === "") {
    errors.push(
      `resolution is required when entering stage "${input.toStage.key}" (require_resolution_on_enter). Allowed: ${TICKET_RESOLUTIONS.join(", ")}.`,
    );
    return errors;
  }
  if (!isTicketResolution(input.resolution)) {
    errors.push(
      `resolution must be one of: ${TICKET_RESOLUTIONS.join(", ")}.`,
    );
  }
  return errors;
}

function validateTokenCount(
  value: number | null | undefined,
  field: string,
): string[] {
  if (value == null || Number.isNaN(value)) {
    return [`${field} is required and must be a non-negative integer.`];
  }
  if (!Number.isInteger(value) || value < 0) {
    return [`${field} must be a non-negative integer.`];
  }
  return [];
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
