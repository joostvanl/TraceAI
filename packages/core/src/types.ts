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
  /**
   * When leaving this gated stage toward a reject target, the comment must
   * include these Markdown headings (case-insensitive). Empty/omitted = no
   * heading gate (a non-empty comment is still required).
   */
  require_comment_sections_on_reject?: string[];
  /**
   * When leaving this gated stage toward a dismiss target, the comment must
   * include these Markdown headings (case-insensitive). Empty/omitted = no
   * heading gate (a non-empty comment is still required).
   */
  require_comment_sections_on_dismiss?: string[];
  /** Suggested comment skeleton shown to agents */
  comment_template?: string;
  /**
   * When leaving this stage for another stage, the transition must include
   * tokens_estimate (LLM token estimate for the whole ticket).
   * @deprecated Prefer require_tokens_estimate_on_exit_to so reject targets
   * are not forced to carry an estimate.
   */
  require_tokens_estimate_on_exit?: boolean;
  /**
   * Require tokens_estimate only when leaving towards one of these stage keys.
   * Takes precedence over require_tokens_estimate_on_exit when set.
   */
  require_tokens_estimate_on_exit_to?: string[];
  /**
   * Require a playbook-complete ticket description (agent_policy headings /
   * min length) only when leaving towards one of these stage keys.
   */
  require_playbook_description_on_exit_to?: string[];
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
   * that is not listed in human_reject_to or human_dismiss_to.
   */
  human_approve_to?: string;
  /**
   * Target stage key(s) for a "rejected" verdict. Empty/omitted means this
   * gate has no reject outcome. Reject hops require a non-empty comment plus
   * any headings in require_comment_sections_on_reject.
   */
  human_reject_to?: string[];
  /**
   * Optional target stage for a "dismissed" verdict (abandon / do not pursue).
   * Omit on gates that should not offer Annuleren. Dismiss hops require a
   * non-empty comment plus any headings in require_comment_sections_on_dismiss.
   */
  human_dismiss_to?: string;
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
   * Extra Markdown headings required on every transition comment
   * (case-insensitive). Omitted or empty = no global heading gate.
   * Parse must not default this to product-specific heading names.
   */
  require_comment_sections?: string[];
  /**
   * When true, every transition must include tokens_used (non-negative integer
   * delta for that step). Accumulated into ticket tokens_actual.
   */
  require_tokens_used_on_transition?: boolean;
  /**
   * When true, agent transitions must include expected_stage (and
   * expected_review_state on a human-gated stage). Missing → 400.
   * Parse: omitted key means not required (compat). Human-proxy is exempt.
   */
  require_expected_stage_on_transition?: boolean;
};

export type WorkflowEditorLayoutNode = {
  id: string;
  x: number;
  y: number;
};

export type WorkflowEditorLayout = {
  nodes: WorkflowEditorLayoutNode[];
};

export type TicketTemplate = {
  slug: string;
  name: string;
  description_headings?: string[];
  default_priority?: Priority;
  seed_body?: string;
};

/** Draft awaiting activate — live board keeps reading top-level stages. */
export type WorkflowPendingDraft = {
  agent_policy: WorkflowAgentPolicy;
  stages: WorkflowStage[];
  editor_layout?: WorkflowEditorLayout;
  ticket_templates?: TicketTemplate[];
  saved_at?: string;
  saved_by?: string;
};

export type WorkflowDocument = {
  version: number;
  agent_policy: WorkflowAgentPolicy;
  stages: WorkflowStage[];
  /** Canvas positions for the visual editor (Aurora stores this inside stages_json). */
  editor_layout?: WorkflowEditorLayout;
  /** Reusable ticket description templates for this workflow. */
  ticket_templates?: TicketTemplate[];
  /**
   * Draft awaiting activate. Live board/agents keep reading top-level
   * `stages` / `agent_policy` until activate merges `pending`.
   */
  pending?: WorkflowPendingDraft | null;
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
  /**
   * Parent ticket (Aurora relation → `ticket`). Empty/omit for a root ticket.
   * Input may be slug or TRA-n; stored/exposed as slug.
   */
  parent?: string | null;
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

export const TICKET_REVIEW_STATES = [
  "approved",
  "rejected",
  "dismissed",
] as const;

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
  /** Aurora relation → `project` (slug at API boundary). */
  project: string;
  /** Aurora relation → `wiki_page`; omit/empty for root. */
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
 *
 * @deprecated Prefer personal `traceai_user` entries (TRA-43). Kept as
 * migration fallback until personal users exist.
 */
export type AppLoginPasswordMarker = { set: true };

export type AppLoginFields = {
  username: string;
  password: AppLoginPasswordMarker | null;
};

/**
 * Personal TraceAI web user (Aurora `traceai_user`). Credentials stay in
 * Aurora; TraceAI UI/API manage entries so humans never need Aurora access.
 */
export type TraceaiUserFields = {
  username: string;
  password: AppLoginPasswordMarker | null;
  display_name: string;
  email?: string | null;
  /** `active` | `disabled` */
  status: string;
  /** Platform-wide admin (all projects + user management). */
  is_platform_admin?: boolean;
};

/**
 * Project membership (Aurora `project_membership`): Aurora `relation` fields
 * to `project` / `traceai_user`, exposed to TraceAI as slug strings, plus
 * role `admin` | `editor` | `viewer`.
 */
export type ProjectMembershipFields = {
  /** Aurora relation → `project` (slug string at API boundary). */
  project: string;
  /** Aurora relation → `traceai_user` (slug string at API boundary). */
  user: string;
  role: string;
};

export type Project = AuroraEntry<ProjectFields>;
export type Workflow = AuroraEntry<WorkflowFields>;
export type Ticket = AuroraEntry<TicketFields>;
export type Comment = AuroraEntry<CommentFields>;
export type WikiPage = AuroraEntry<WikiPageFields>;
export type AppLogin = AuroraEntry<AppLoginFields>;
export type TraceaiUser = AuroraEntry<TraceaiUserFields>;
export type ProjectMembership = AuroraEntry<ProjectMembershipFields>;

export const APP_LOGIN_CONTENT_TYPE = "app_login";
export const APP_LOGIN_ENTRY_SLUG = "default";
export const TRACEAI_USER_CONTENT_TYPE = "traceai_user";
export const PROJECT_MEMBERSHIP_CONTENT_TYPE = "project_membership";
export const WIKI_PAGE_CONTENT_TYPE = "wiki_page";
/** Upper bound (and default) for one page of a wiki listing. */
export const WIKI_PAGE_LIST_MAX = 500;

/** Session / login identity returned by TraceAI UI auth. */
export type UiIdentity = {
  /** Login username (stable attribution string). */
  user: string;
  /** Aurora `traceai_user` slug when personal; null for legacy app_login. */
  slug: string | null;
  display_name: string;
  is_platform_admin: boolean;
  mode: "personal" | "legacy";
};

export type ListResult<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
};

export const DEFAULT_AGENT_POLICY: WorkflowAgentPolicy = {
  summary:
    "TraceAI tickets must be self-contained for junior agents. Every workflow transition needs a Markdown comment describing completed work, plus tokens_used (self-reported LLM token delta for that step). Required comment headings come from workflow JSON, not from core.",
  ticket_description: [
    "Write descriptions that a junior agent with no chat history can execute alone.",
    "Include: Context, Goal, What to implement (concrete steps), Out of scope, Acceptance criteria.",
    "Use Markdown headings (##) for those sections.",
    "Link related ticket slugs when there are dependencies.",
    "Never leave only a one-line title-as-description.",
  ],
  on_every_transition: [
    "Before changing stage, post a Markdown comment on the ticket.",
    "Required Markdown headings are only those listed in this workflow JSON (agent_policy.require_comment_sections and per-stage require_comment_sections_on_*). If those lists are empty, a short comment without ## headings is enough.",
    "Keep the comment additive: new facts for this hop, not a recap of the previous comment or the ticket description.",
    "List concrete artifacts (files, endpoints, commands) when relevant.",
    "Pass tokens_used: a non-negative integer estimate of LLM tokens (prompt+completion) spent on this step.",
    "Call get_ticket immediately before transition_ticket. Pass expected_stage (current stage). When the current stage has require_human_approval_on_exit, also pass expected_review_state (current review_state, or null). Workflows with require_expected_stage_on_transition refuse the call without the required fields. On STAGE_CONFLICT, read the error body; do not retry the same transition.",
    "Stages with require_human_approval_on_exit need a human verdict in the UI (configured outcomes: approved / rejected / dismissed as applicable) before the agent may transition out.",
  ],
  min_description_chars: 280,
  require_description_headings: [
    "## Context",
    "## Goal",
    "## What to implement",
    "## Acceptance criteria",
  ],
  require_tokens_used_on_transition: true,
  require_expected_stage_on_transition: true,
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
    transitions: ["todo", "backlog", "done"],
    agent: {
      purpose: "Description is being sharpened into an executable playbook.",
      on_enter: [
        "Confirm the ticket is ready to be rewritten with Context/Goal/What to implement/Acceptance criteria.",
      ],
      on_exit: [
        "Wait for the human verdict in the UI (outcomes configured on this stage); only then transition.",
        "When moving to the approve target, confirm the description is complete enough for a junior agent.",
        "If the verdict is rejected, move to the reject target and include the headings listed in require_comment_sections_on_reject.",
        "If the verdict is dismissed, move to the dismiss target with the headings listed in require_comment_sections_on_dismiss and the Done enter requirements (resolution, ## Wiki).",
        "Pass tokens_estimate when leaving toward a target that requires it.",
      ],
      require_comment_on_exit: true,
      require_tokens_estimate_on_exit_to: ["todo"],
      require_playbook_description_on_exit_to: ["todo"],
      require_human_approval_on_exit: true,
      human_approve_to: "todo",
      human_reject_to: ["backlog"],
      human_dismiss_to: "done",
      require_comment_sections_on_reject: ["## Reden"],
      require_comment_sections_on_dismiss: ["## Reden"],
    },
  },
  {
    key: "todo",
    name: "To do",
    transitions: ["in_progress", "backlog", "in_refinement", "done"],
    agent: {
      purpose:
        "Ready to start — human intake gate: approve to begin, or dismiss to close without work.",
      on_enter: ["Confirm dependencies are clear in the description."],
      on_exit: [
        "Wait for the human intake verdict; only then transition.",
        "When approved, describe the first implementation step and confirm work can start.",
        "When dismissed, move to the dismiss target with the headings listed in require_comment_sections_on_dismiss, an appropriate non-completed resolution, and ## Wiki.",
        "When returning to Backlog or In Refinement (if allowed without this gate), explain why the ticket is no longer ready.",
      ],
      require_comment_on_exit: true,
      require_human_approval_on_exit: true,
      human_approve_to: "in_progress",
      human_dismiss_to: "done",
      require_comment_sections_on_dismiss: ["## Reden"],
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
        "## Testverslag\n- Test: ...\n- Resultaat: PASS/FAIL\n\n## Uitslag\nPASS|FAIL",
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
        "Wait for the human verdict in the UI (outcomes configured on this stage); only then transition.",
        "If the verdict is rejected, move to the reject target and include the headings listed in require_comment_sections_on_reject.",
        "If approved toward Done with resolution completed, confirm acceptance criteria and ## Uitslag PASS.",
        "When moving to Done, include the required ## Wiki section.",
      ],
      require_comment_on_exit: true,
      require_human_approval_on_exit: true,
      human_approve_to: "done",
      human_reject_to: ["todo"],
      require_comment_sections_on_reject: ["## Reden"],
      comment_template:
        "## Testverslag\n- `pnpm --filter @traceai/api build` — PASS\n- Manual check: ... — PASS\n\n## Uitslag\nPASS",
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
    require_comment_sections_on_reject: Array.isArray(
      item.require_comment_sections_on_reject,
    )
      ? item.require_comment_sections_on_reject.map((s) => String(s))
      : undefined,
    require_comment_sections_on_dismiss: Array.isArray(
      item.require_comment_sections_on_dismiss,
    )
      ? item.require_comment_sections_on_dismiss.map((s) => String(s))
      : undefined,
    comment_template:
      item.comment_template != null ? String(item.comment_template) : undefined,
    require_tokens_estimate_on_exit:
      typeof item.require_tokens_estimate_on_exit === "boolean"
        ? item.require_tokens_estimate_on_exit
        : undefined,
    require_tokens_estimate_on_exit_to: Array.isArray(
      item.require_tokens_estimate_on_exit_to,
    )
      ? item.require_tokens_estimate_on_exit_to.map((s) => String(s))
      : undefined,
    require_playbook_description_on_exit_to: Array.isArray(
      item.require_playbook_description_on_exit_to,
    )
      ? item.require_playbook_description_on_exit_to.map((s) => String(s))
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
    human_dismiss_to:
      item.human_dismiss_to != null && String(item.human_dismiss_to).trim()
        ? String(item.human_dismiss_to).trim()
        : undefined,
  };
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
        // No key-name fallback: live stages only get rules that are configured.
        agent: parseStageAgent(item.agent),
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
    // Omitted/empty = no global heading gate. Never default to product headings.
    require_comment_sections: Array.isArray(item.require_comment_sections)
      ? item.require_comment_sections.map((s) => String(s))
      : undefined,
    // Do not fall back to DEFAULT — missing means "not required" (compat).
    require_tokens_used_on_transition:
      typeof item.require_tokens_used_on_transition === "boolean"
        ? item.require_tokens_used_on_transition
        : undefined,
    require_expected_stage_on_transition:
      typeof item.require_expected_stage_on_transition === "boolean"
        ? item.require_expected_stage_on_transition
        : undefined,
  };
}

function parseEditorLayout(raw: unknown): WorkflowEditorLayout | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const nodesRaw = (raw as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodesRaw)) return undefined;
  const nodes = nodesRaw
    .filter((n): n is Record<string, unknown> => !!n && typeof n === "object")
    .map((n) => ({
      id: String(n.id ?? ""),
      x: typeof n.x === "number" ? n.x : 0,
      y: typeof n.y === "number" ? n.y : 0,
    }))
    .filter((n) => n.id.length > 0);
  return nodes.length ? { nodes } : undefined;
}

function parseTicketTemplates(raw: unknown): TicketTemplate[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const templates = raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => {
      const slug = String(t.slug ?? "").trim();
      const name = String(t.name ?? slug).trim();
      const priority =
        t.default_priority === "low" ||
        t.default_priority === "medium" ||
        t.default_priority === "high"
          ? t.default_priority
          : undefined;
      return {
        slug,
        name,
        description_headings: Array.isArray(t.description_headings)
          ? t.description_headings.map((h) => String(h))
          : undefined,
        default_priority: priority,
        seed_body: t.seed_body != null ? String(t.seed_body) : undefined,
      } satisfies TicketTemplate;
    })
    .filter((t) => t.slug.length > 0 && t.name.length > 0);
  return templates.length ? templates : undefined;
}

function parsePendingDraft(raw: unknown): WorkflowPendingDraft | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const stages = parseStageList(obj.stages);
  if (!stages.length) return undefined;
  return {
    agent_policy: parseAgentPolicy(obj.agent_policy),
    stages,
    editor_layout: parseEditorLayout(obj.editor_layout),
    ticket_templates: parseTicketTemplates(obj.ticket_templates),
    saved_at: obj.saved_at != null ? String(obj.saved_at) : undefined,
    saved_by: obj.saved_by != null ? String(obj.saved_by) : undefined,
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
        editor_layout: parseEditorLayout(obj.editor_layout),
        ticket_templates: parseTicketTemplates(obj.ticket_templates),
        pending: parsePendingDraft(obj.pending),
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

/**
 * True when leaving `fromStage` towards `toKey` requires a playbook-complete
 * description, based solely on require_playbook_description_on_exit_to.
 */
export function exitRequiresPlaybookDescription(
  fromStage: WorkflowStage,
  toKey: string,
): boolean {
  if (fromStage.key === toKey) return false;
  const targets = fromStage.agent?.require_playbook_description_on_exit_to;
  return Array.isArray(targets) && targets.includes(toKey);
}

/**
 * True when leaving `fromStage` towards `toKey` requires tokens_estimate.
 * Prefer require_tokens_estimate_on_exit_to; legacy boolean applies to every
 * exit except configured human_reject_to targets (so reject paths stay usable).
 */
export function exitRequiresTokensEstimate(
  fromStage: WorkflowStage,
  toKey: string,
): boolean {
  if (fromStage.key === toKey) return false;
  const targets = fromStage.agent?.require_tokens_estimate_on_exit_to;
  if (Array.isArray(targets)) return targets.includes(toKey);
  if (fromStage.agent?.require_tokens_estimate_on_exit !== true) return false;
  if (fromStage.agent?.require_human_approval_on_exit === true) {
    return !humanRejectTargets(fromStage).includes(toKey);
  }
  return true;
}

/**
 * Approve target for a human-gated stage. Prefer explicit `human_approve_to`,
 * otherwise the first transition not listed as reject or dismiss.
 */
export function humanApproveTarget(stage: WorkflowStage): string | null {
  const explicit = stage.agent?.human_approve_to?.trim();
  if (explicit && stage.transitions.includes(explicit)) return explicit;
  const dismiss = humanDismissTarget(stage);
  const reserved = new Set([
    ...humanRejectTargets(stage),
    ...(dismiss ? [dismiss] : []),
  ]);
  return stage.transitions.find((t) => !reserved.has(t)) ?? null;
}

/**
 * Reject target(s) for a human-gated stage. Only explicitly configured keys;
 * empty/omitted means this gate has no reject outcome (no invented fallback).
 */
export function humanRejectTargets(stage: WorkflowStage): string[] {
  const configured = stage.agent?.human_reject_to ?? [];
  return configured.filter((t) => stage.transitions.includes(t));
}

/** Dismiss target for a human-gated stage, or null when not configured. */
export function humanDismissTarget(stage: WorkflowStage): string | null {
  const explicit = stage.agent?.human_dismiss_to?.trim();
  if (explicit && stage.transitions.includes(explicit)) return explicit;
  return null;
}

/**
 * Where a human verdict may take a gated stage. `null` outside a gate or when
 * that verdict outcome is not configured on the stage.
 */
export function reviewVerdictTarget(
  stage: WorkflowStage,
  verdict: TicketReviewState,
): string | null {
  if (stage.agent?.require_human_approval_on_exit !== true) return null;
  if (verdict === "approved") return humanApproveTarget(stage);
  if (verdict === "dismissed") return humanDismissTarget(stage);
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
  const dismissTo = humanDismissTarget(input.fromStage);
  const rejecting = rejects.includes(input.toStage.key);
  const dismissing = dismissTo === input.toStage.key;

  if (!input.asHuman) {
    const verdict = input.reviewState?.trim();
    if (!isTicketReviewState(verdict)) {
      errors.push(
        `Stage "${input.fromStage.key}" is waiting for a human review verdict. Ask the reviewer to use Goedkeuren/Afkeuren/Annuleren in the TraceAI UI (as configured for this stage), then transition on the back of that verdict.`,
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

  if (rejecting || dismissing) {
    const comment = input.comment?.trim() ?? "";
    if (!comment) {
      errors.push(
        `Leaving "${input.fromStage.key}" towards "${input.toStage.key}" requires a comment.`,
      );
    }
    const sections = rejecting
      ? input.fromStage.agent?.require_comment_sections_on_reject
      : input.fromStage.agent?.require_comment_sections_on_dismiss;
    pushMissingCommentSections(
      errors,
      comment,
      sections,
      (section) =>
        `Leaving "${input.fromStage.key}" towards "${input.toStage.key}" requires comment section "${section}".`,
    );
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
  if (input.verdict === "approved" && !humanApproveTarget(input.stage)) {
    errors.push(
      `Stage "${input.stage.key}" has no approve target configured for an approved verdict.`,
    );
  }
  if (input.verdict === "rejected" && humanRejectTargets(input.stage).length === 0) {
    errors.push(
      `Stage "${input.stage.key}" has no reject target configured; rejected is not allowed.`,
    );
  }
  if (input.verdict === "dismissed" && !humanDismissTarget(input.stage)) {
    errors.push(
      `Stage "${input.stage.key}" has no dismiss target configured; dismissed is not allowed.`,
    );
  }
  if (
    (input.verdict === "rejected" || input.verdict === "dismissed") &&
    !input.comment?.trim()
  ) {
    errors.push(
      input.verdict === "dismissed"
        ? "Dismissing requires a reason."
        : "Rejecting a review requires a reason.",
    );
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

function pushMissingCommentSections(
  errors: string[],
  comment: string,
  sections: string[] | undefined,
  message: (section: string) => string,
): void {
  for (const section of sections ?? []) {
    if (!normalizeHeading(comment).includes(normalizeHeading(section))) {
      errors.push(message(section));
    }
  }
}

/** Audit comment posted when a human records a review verdict. */
export function formatReviewVerdictComment(input: {
  stage: WorkflowStage;
  verdict: TicketReviewState;
  author: string;
  target: string | null;
  comment?: string | null;
  cascadeNote?: string;
}): string {
  const cascade = input.cascadeNote ?? "";
  const targetLabel = input.target ?? "—";
  const action =
    input.verdict === "approved"
      ? `Goedgekeurd door ${input.author}${cascade}. De agent mag dit ticket nu naar "${targetLabel}" brengen.`
      : input.verdict === "dismissed"
        ? `Afgezien door ${input.author}${cascade}. De agent brengt dit ticket naar "${targetLabel}".`
        : `Afgekeurd door ${input.author}${cascade}. De agent brengt dit ticket terug naar "${targetLabel}".`;
  const note = input.comment?.trim() ?? "";
  if (!note) return action;
  const headingList =
    input.verdict === "rejected"
      ? input.stage.agent?.require_comment_sections_on_reject
      : input.verdict === "dismissed"
        ? input.stage.agent?.require_comment_sections_on_dismiss
        : undefined;
  const heading = headingList?.[0]?.trim();
  if (heading) return `${action}\n\n${heading}\n${note}`;
  return `${action}\n\n${note}`;
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
    pushMissingCommentSections(
      errors,
      comment,
      input.policy.require_comment_sections,
      (section) => `Transition comment must include heading "${section}".`,
    );
  }

  const requiredSections =
    input.toStage.agent?.require_comment_sections_on_enter ?? [];
  pushMissingCommentSections(
    errors,
    comment,
    requiredSections,
    (section) => `Entering "${input.toStage.key}" requires comment section "${section}".`,
  );

  if (input.fromStage.key !== input.toStage.key) {
    pushMissingCommentSections(
      errors,
      comment,
      input.fromStage.agent?.require_comment_sections_on_exit,
      (section) =>
        `Leaving "${input.fromStage.key}" requires comment section "${section}".`,
    );
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
  const leavingMarkedStage = exitRequiresTokensEstimate(
    input.fromStage,
    input.toStage.key,
  );

  if (leavingMarkedStage) {
    const estimateErrors = validateTokenCount(
      input.tokens_estimate,
      "tokens_estimate",
    );
    if (estimateErrors.length) {
      errors.push(
        ...estimateErrors.map(
          (e) =>
            `${e} Required when leaving stage "${input.fromStage.key}" towards "${input.toStage.key}" (require_tokens_estimate_on_exit_to / require_tokens_estimate_on_exit).`,
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
