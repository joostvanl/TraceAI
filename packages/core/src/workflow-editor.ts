import type {
  Priority,
  TicketTemplate,
  WorkflowAgentPolicy,
  WorkflowDocument,
  WorkflowEditorLayout,
  WorkflowPendingDraft,
  WorkflowStage,
  WorkflowStageAgentRules,
} from "./types.js";
import { humanApproveTarget, humanRejectTargets } from "./types.js";

export type {
  TicketTemplate,
  WorkflowEditorLayout,
  WorkflowEditorLayoutNode,
  WorkflowPendingDraft,
} from "./types.js";

export type WorkflowValidationIssue = {
  code: string;
  message: string;
  path?: string;
};

export class WorkflowValidationError extends Error {
  constructor(readonly issues: WorkflowValidationIssue[]) {
    super(issues.map((issue) => issue.message).join(" "));
    this.name = "WorkflowValidationError";
  }
}

export type WorkflowGraphEdge = {
  id: string;
  source: string;
  target: string;
};

export type WorkflowCanvasModel = {
  stages: WorkflowStage[];
  edges: WorkflowGraphEdge[];
  layout: WorkflowEditorLayout;
  agent_policy: WorkflowAgentPolicy;
  ticket_templates: TicketTemplate[];
};

export type TicketMigrationHit = {
  slug: string;
  ticket_key: string | null;
  title: string;
  stage: string;
};

export type WorkflowMigrationImpact = {
  live_stages: string[];
  pending_stages: string[];
  removed_stages: string[];
  added_stages: string[];
  tickets_by_removed_stage: Record<string, TicketMigrationHit[]>;
  tickets_needing_migration: number;
};

export type StageMigrationMap = Record<string, string>;

const DEFAULT_LAYOUT_GAP_X = 240;
const DEFAULT_LAYOUT_GAP_Y = 120;

export function defaultEditorLayout(stages: WorkflowStage[]): WorkflowEditorLayout {
  return {
    nodes: stages.map((stage, index) => ({
      id: stage.key,
      x: 80 + (index % 3) * DEFAULT_LAYOUT_GAP_X,
      y: 80 + Math.floor(index / 3) * DEFAULT_LAYOUT_GAP_Y,
    })),
  };
}

export function stagesToEdges(stages: WorkflowStage[]): WorkflowGraphEdge[] {
  const edges: WorkflowGraphEdge[] = [];
  for (const stage of stages) {
    for (const target of stage.transitions) {
      edges.push({
        id: `${stage.key}->${target}`,
        source: stage.key,
        target,
      });
    }
  }
  return edges;
}

/**
 * Build transitions from canvas edges. Edge-only model: transitions remain
 * `string[]` on the source stage (no first-class edge schema).
 */
export function applyEdgesToStages(
  stages: WorkflowStage[],
  edges: WorkflowGraphEdge[],
): WorkflowStage[] {
  const bySource = new Map<string, string[]>();
  for (const edge of edges) {
    const list = bySource.get(edge.source) ?? [];
    if (!list.includes(edge.target)) list.push(edge.target);
    bySource.set(edge.source, list);
  }
  return stages.map((stage) => ({
    ...stage,
    transitions: bySource.get(stage.key) ?? [],
  }));
}

/** Target-scoped agent flags that conceptually belong to an edge from→to. */
export type EdgeScopedAgentRules = {
  require_tokens_estimate: boolean;
  require_playbook_description: boolean;
};

export function getEdgeScopedRules(
  stage: WorkflowStage | undefined,
  targetKey: string,
): EdgeScopedAgentRules {
  const agent = stage?.agent;
  const estimateTargets = agent?.require_tokens_estimate_on_exit_to;
  const playbookTargets = agent?.require_playbook_description_on_exit_to;
  return {
    require_tokens_estimate: Array.isArray(estimateTargets)
      ? estimateTargets.includes(targetKey)
      : Boolean(agent?.require_tokens_estimate_on_exit),
    require_playbook_description: Array.isArray(playbookTargets)
      ? playbookTargets.includes(targetKey)
      : false,
  };
}

function toggleTargetList(
  list: string[] | undefined,
  target: string,
  enabled: boolean,
): string[] | undefined {
  const current = list ?? [];
  if (enabled) {
    return current.includes(target) ? current : [...current, target];
  }
  const next = current.filter((key) => key !== target);
  return next.length ? next : undefined;
}

/** Persist edge-scoped rules onto the source stage agent config. */
export function setEdgeScopedRules(
  stage: WorkflowStage,
  targetKey: string,
  rules: EdgeScopedAgentRules,
): WorkflowStage {
  const agent: WorkflowStageAgentRules = { ...(stage.agent ?? {}) };
  agent.require_tokens_estimate_on_exit_to = toggleTargetList(
    agent.require_tokens_estimate_on_exit_to,
    targetKey,
    rules.require_tokens_estimate,
  );
  // Clear deprecated blanket flag when using target-scoped lists.
  if (agent.require_tokens_estimate_on_exit_to?.length) {
    delete agent.require_tokens_estimate_on_exit;
  }
  agent.require_playbook_description_on_exit_to = toggleTargetList(
    agent.require_playbook_description_on_exit_to,
    targetKey,
    rules.require_playbook_description,
  );
  return { ...stage, agent };
}

export function documentToCanvas(doc: WorkflowDocument): WorkflowCanvasModel {
  const working = effectiveEditableDocument(doc);
  const layout =
    working.editor_layout?.nodes?.length
      ? working.editor_layout
      : defaultEditorLayout(working.stages);
  return {
    stages: working.stages,
    edges: stagesToEdges(working.stages),
    layout,
    agent_policy: working.agent_policy,
    ticket_templates: working.ticket_templates ?? [],
  };
}

export function canvasToPendingDraft(
  canvas: WorkflowCanvasModel,
  meta?: { saved_by?: string; saved_at?: string },
): WorkflowPendingDraft {
  const stages = applyEdgesToStages(canvas.stages, canvas.edges);
  return {
    agent_policy: canvas.agent_policy,
    stages,
    editor_layout: canvas.layout,
    ticket_templates: canvas.ticket_templates,
    saved_at: meta?.saved_at ?? new Date().toISOString(),
    saved_by: meta?.saved_by,
  };
}

/** Live stages stay active until activate merges pending. */
export function effectiveEditableDocument(doc: WorkflowDocument): {
  agent_policy: WorkflowAgentPolicy;
  stages: WorkflowStage[];
  editor_layout?: WorkflowEditorLayout;
  ticket_templates?: TicketTemplate[];
} {
  if (doc.pending) {
    return {
      agent_policy: doc.pending.agent_policy,
      stages: doc.pending.stages,
      editor_layout: doc.pending.editor_layout ?? doc.editor_layout,
      ticket_templates: doc.pending.ticket_templates ?? doc.ticket_templates,
    };
  }
  return {
    agent_policy: doc.agent_policy,
    stages: doc.stages,
    editor_layout: doc.editor_layout,
    ticket_templates: doc.ticket_templates,
  };
}

export function validateWorkflowDocument(
  doc: Pick<WorkflowDocument, "stages" | "agent_policy"> & {
    stages: WorkflowStage[];
  },
): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  const stages = doc.stages ?? [];

  if (stages.length === 0) {
    issues.push({
      code: "NO_STAGES",
      message: "Workflow moet minstens één stage hebben.",
      path: "stages",
    });
    return issues;
  }

  const keys = stages.map((s) => s.key.trim());
  const seen = new Set<string>();
  for (const [index, key] of keys.entries()) {
    if (!key) {
      issues.push({
        code: "EMPTY_KEY",
        message: `Stage op index ${index} heeft geen key.`,
        path: `stages[${index}].key`,
      });
      continue;
    }
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      issues.push({
        code: "INVALID_KEY",
        message: `Stage key "${key}" moet beginnen met een letter en alleen a-z, 0-9, _ bevatten.`,
        path: `stages[${index}].key`,
      });
    }
    if (seen.has(key)) {
      issues.push({
        code: "DUPLICATE_KEY",
        message: `Dubbele stage key "${key}".`,
        path: `stages[${index}].key`,
      });
    }
    seen.add(key);
  }

  const keySet = new Set(keys.filter(Boolean));
  for (const stage of stages) {
    if (!stage.name?.trim()) {
      issues.push({
        code: "EMPTY_NAME",
        message: `Stage "${stage.key}" heeft geen weergavenaam.`,
        path: `stages.${stage.key}.name`,
      });
    }
    for (const target of stage.transitions) {
      if (!keySet.has(target)) {
        issues.push({
          code: "UNKNOWN_TRANSITION",
          message: `Stage "${stage.key}" heeft transition naar onbekende stage "${target}".`,
          path: `stages.${stage.key}.transitions`,
        });
      }
    }

    if (stage.agent?.require_human_approval_on_exit) {
      const explicitApprove = stage.agent.human_approve_to?.trim();
      const approve = humanApproveTarget(stage);
      const rejects = humanRejectTargets(stage);
      if (explicitApprove && !stage.transitions.includes(explicitApprove)) {
        issues.push({
          code: "HUMAN_APPROVE_INVALID",
          message: `Stage "${stage.key}" heeft human gate maar approve-target "${explicitApprove}" zit niet in transitions.`,
          path: `stages.${stage.key}.agent.human_approve_to`,
        });
      } else if (!approve || !stage.transitions.includes(approve)) {
        issues.push({
          code: "HUMAN_APPROVE_INVALID",
          message: `Stage "${stage.key}" heeft human gate maar approve-target ontbreekt of zit niet in transitions.`,
          path: `stages.${stage.key}.agent.human_approve_to`,
        });
      }
      const configuredRejects = stage.agent.human_reject_to ?? [];
      for (const reject of configuredRejects) {
        if (!stage.transitions.includes(reject)) {
          issues.push({
            code: "HUMAN_REJECT_INVALID",
            message: `Stage "${stage.key}" reject-target "${reject}" zit niet in transitions.`,
            path: `stages.${stage.key}.agent.human_reject_to`,
          });
        }
      }
      if (!configuredRejects.length && !rejects.length && stage.transitions.length < 2) {
        issues.push({
          code: "HUMAN_REJECT_INVALID",
          message: `Stage "${stage.key}" heeft human gate maar geen reject-target.`,
          path: `stages.${stage.key}.agent.human_reject_to`,
        });
      }
      for (const target of stage.agent.require_tokens_estimate_on_exit_to ?? []) {
        if (!stage.transitions.includes(target)) {
          issues.push({
            code: "TOKENS_ESTIMATE_TARGET_INVALID",
            message: `Stage "${stage.key}" require_tokens_estimate_on_exit_to bevat onbekende/ontbrekende transition "${target}".`,
            path: `stages.${stage.key}.agent.require_tokens_estimate_on_exit_to`,
          });
        }
      }
      for (const target of stage.agent.require_playbook_description_on_exit_to ?? []) {
        if (!stage.transitions.includes(target)) {
          issues.push({
            code: "PLAYBOOK_TARGET_INVALID",
            message: `Stage "${stage.key}" require_playbook_description_on_exit_to bevat onbekende/ontbrekende transition "${target}".`,
            path: `stages.${stage.key}.agent.require_playbook_description_on_exit_to`,
          });
        }
      }
    } else {
      for (const target of stage.agent?.require_tokens_estimate_on_exit_to ?? []) {
        if (!stage.transitions.includes(target)) {
          issues.push({
            code: "TOKENS_ESTIMATE_TARGET_INVALID",
            message: `Stage "${stage.key}" require_tokens_estimate_on_exit_to bevat onbekende/ontbrekende transition "${target}".`,
            path: `stages.${stage.key}.agent.require_tokens_estimate_on_exit_to`,
          });
        }
      }
      for (const target of stage.agent?.require_playbook_description_on_exit_to ?? []) {
        if (!stage.transitions.includes(target)) {
          issues.push({
            code: "PLAYBOOK_TARGET_INVALID",
            message: `Stage "${stage.key}" require_playbook_description_on_exit_to bevat onbekende/ontbrekende transition "${target}".`,
            path: `stages.${stage.key}.agent.require_playbook_description_on_exit_to`,
          });
        }
      }
    }
  }

  // Reachability from first stage (array order = start).
  const start = stages[0]?.key;
  if (start) {
    const reachable = new Set<string>();
    const queue = [start];
    while (queue.length) {
      const key = queue.shift()!;
      if (reachable.has(key)) continue;
      reachable.add(key);
      const stage = stages.find((s) => s.key === key);
      for (const target of stage?.transitions ?? []) {
        if (keySet.has(target) && !reachable.has(target)) queue.push(target);
      }
    }
    for (const key of keySet) {
      if (!reachable.has(key)) {
        issues.push({
          code: "UNREACHABLE_STAGE",
          message: `Stage "${key}" is niet bereikbaar vanaf startstage "${start}".`,
          path: `stages.${key}`,
        });
      }
    }
  }

  if (!doc.agent_policy?.summary?.trim()) {
    issues.push({
      code: "POLICY_SUMMARY",
      message: "agent_policy.summary mag niet leeg zijn.",
      path: "agent_policy.summary",
    });
  }

  return issues;
}

export function computeMigrationImpact(
  liveStages: WorkflowStage[],
  pendingStages: WorkflowStage[],
  tickets: TicketMigrationHit[],
): WorkflowMigrationImpact {
  const liveKeys = liveStages.map((s) => s.key);
  const pendingKeys = pendingStages.map((s) => s.key);
  const pendingSet = new Set(pendingKeys);
  const liveSet = new Set(liveKeys);
  const removed_stages = liveKeys.filter((key) => !pendingSet.has(key));
  const added_stages = pendingKeys.filter((key) => !liveSet.has(key));
  const tickets_by_removed_stage: Record<string, TicketMigrationHit[]> = {};
  for (const stage of removed_stages) {
    tickets_by_removed_stage[stage] = tickets.filter((t) => t.stage === stage);
  }
  const tickets_needing_migration = removed_stages.reduce(
    (sum, stage) => sum + (tickets_by_removed_stage[stage]?.length ?? 0),
    0,
  );
  return {
    live_stages: liveKeys,
    pending_stages: pendingKeys,
    removed_stages,
    added_stages,
    tickets_by_removed_stage,
    tickets_needing_migration,
  };
}

export function validateMigrationMap(
  impact: WorkflowMigrationImpact,
  migration: StageMigrationMap,
  pendingStageKeys: string[],
): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  const pendingSet = new Set(pendingStageKeys);
  for (const removed of impact.removed_stages) {
    const hits = impact.tickets_by_removed_stage[removed] ?? [];
    if (hits.length === 0) continue;
    const target = migration[removed];
    if (!target) {
      issues.push({
        code: "MIGRATION_REQUIRED",
        message: `Stage "${removed}" verdwijnt en heeft ${hits.length} ticket(s); kies een migratiedoel.`,
        path: `migration.${removed}`,
      });
      continue;
    }
    if (!pendingSet.has(target)) {
      issues.push({
        code: "MIGRATION_TARGET_INVALID",
        message: `Migratie van "${removed}" naar "${target}" faalt: doel bestaat niet in de nieuwe workflow.`,
        path: `migration.${removed}`,
      });
    }
  }
  return issues;
}

export type ApplyTemplateMode = "fill_empty" | "confirm_overwrite" | "merge_headings";

export type ApplyTemplateResult = {
  title?: string;
  description: string;
  priority?: Priority;
  overwritten: boolean;
};

/**
 * Apply a ticket template without silently destroying existing content.
 * - fill_empty: only fill blank description/priority
 * - confirm_overwrite: caller must pass confirmed=true to replace description
 * - merge_headings: ensure required headings exist; keep existing body sections
 */
export function applyTicketTemplate(
  template: TicketTemplate,
  current: { title?: string; description?: string; priority?: Priority | string },
  options: { mode: ApplyTemplateMode; confirmed?: boolean },
): ApplyTemplateResult {
  const headings =
    template.description_headings?.length
      ? template.description_headings
      : ["## Context", "## Goal", "## What to implement", "## Acceptance criteria"];
  const seed = template.seed_body?.trim() || headings.map((h) => `${h}\n\n`).join("");
  const existing = current.description?.trim() ?? "";

  if (options.mode === "fill_empty") {
    return {
      description: existing || seed,
      priority: (current.priority as Priority | undefined) || template.default_priority,
      overwritten: !existing && Boolean(seed),
    };
  }

  if (options.mode === "confirm_overwrite") {
    if (existing && !options.confirmed) {
      throw new Error(
        "Template zou bestaande description overschrijven; bevestig expliciet (confirmed=true).",
      );
    }
    return {
      description: seed,
      priority: template.default_priority ?? (current.priority as Priority | undefined),
      overwritten: Boolean(existing),
    };
  }

  // merge_headings
  let description = existing || seed;
  for (const heading of headings) {
    const re = new RegExp(`^${escapeRegExp(heading)}\\s*$`, "im");
    if (!re.test(description)) {
      description = `${description.trimEnd()}\n\n${heading}\n\n`;
    }
  }
  return {
    description,
    priority: (current.priority as Priority | undefined) || template.default_priority,
    overwritten: false,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function summarizeWorkflowBehaviour(doc: {
  stages: WorkflowStage[];
  agent_policy: WorkflowAgentPolicy;
}): string {
  const lines: string[] = [];
  lines.push(`Policy: ${doc.agent_policy.summary}`);
  lines.push(`Stages (${doc.stages.length}):`);
  for (const stage of doc.stages) {
    const transitions =
      stage.transitions.length > 0 ? stage.transitions.join(", ") : "(geen)";
    const gate = stage.agent?.require_human_approval_on_exit
      ? ` [human gate → approve:${humanApproveTarget(stage) ?? "?"} reject:${humanRejectTargets(stage).join("|") || "—"}]`
      : "";
    lines.push(`- ${stage.name} (${stage.key}) → ${transitions}${gate}`);
  }
  return lines.join("\n");
}
