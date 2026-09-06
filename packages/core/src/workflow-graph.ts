import { relationSlug } from "./relations.js";
import { ValidationError } from "./trace-errors.js";
import {
  parseWorkflowDocument,
  type WorkflowAgentPolicy,
  type WorkflowDocument,
  type WorkflowStage,
  type WorkflowStageAgentRules,
  type WorkflowStorageModel,
} from "./types.js";
import {
  applyEdgesToStages,
  getEdgeScopedRules,
  setEdgeScopedRules,
  type WorkflowGraphEdge,
} from "./workflow-editor.js";

export const GRAPH_EDITOR_UNSUPPORTED =
  "De visuele editor ondersteunt graph-workflows nog niet. Bewerk deze workflow via MCP/API, of gebruik een legacy_json-workflow.";

export type SlimWorkflowStage = {
  key: string;
  name: string;
  transitions: string[];
};

export type GraphStagePart = {
  key: string;
  name: string;
  sort_order: number;
  catalog_key?: string;
  agent?: WorkflowStageAgentRules;
};

export type GraphEdgePart = {
  from_key: string;
  to_key: string;
  require_tokens_estimate: boolean;
  require_playbook_description: boolean;
};

export type GraphWorkflowParts = {
  version: number;
  agent_policy: WorkflowAgentPolicy;
  ticket_templates?: WorkflowDocument["ticket_templates"];
  stages: GraphStagePart[];
  edges: GraphEdgePart[];
};

export function parseWorkflowStorageModel(
  value: unknown,
): WorkflowStorageModel {
  return value === "graph" ? "graph" : "legacy_json";
}

export type GraphStageEndpoint = {
  slug: string;
  fields: { key: string };
};

/** Resolve an edge from/to relation (stage slug) to the stage key used in documents. */
export function resolveGraphEdgeEndpointKey(
  relation: unknown,
  stages: GraphStageEndpoint[],
): string {
  const slug = relationSlug(relation);
  if (!slug) {
    throw new ValidationError("Edge from/to must point to a workflow stage");
  }
  const bySlug = stages.find((stage) => stage.slug === slug);
  if (bySlug) return bySlug.fields.key;
  const byKey = stages.find((stage) => stage.fields.key === slug);
  if (byKey) return byKey.fields.key;
  return slug;
}

/** Persist an internal stage key as the workflow_stage entry slug. */
export function stageSlugForEdgeEndpoint(
  stageKey: string,
  stages: GraphStageEndpoint[],
): string {
  const found = stages.find((stage) => stage.fields.key === stageKey);
  if (!found) {
    throw new ValidationError(
      `Edge endpoint "${stageKey}" does not match a stage in this workflow`,
    );
  }
  return found.slug;
}

export function wantsFullWorkflowInclude(include: unknown): boolean {
  return include === "full";
}

export function slimWorkflowStages(stages: WorkflowStage[]): SlimWorkflowStage[] {
  return stages.map((stage) => ({
    key: stage.key,
    name: stage.name,
    transitions: [...stage.transitions],
  }));
}

function stripEdgeScopedAgent(
  agent: WorkflowStageAgentRules | undefined,
): WorkflowStageAgentRules | undefined {
  if (!agent) return undefined;
  const next: WorkflowStageAgentRules = { ...agent };
  delete next.require_tokens_estimate_on_exit;
  delete next.require_tokens_estimate_on_exit_to;
  delete next.require_playbook_description_on_exit_to;
  return next;
}

export function assertUniqueGraphEdges(edges: GraphEdgePart[]): void {
  const seen = new Set<string>();
  for (const edge of edges) {
    const id = `${edge.from_key}\0${edge.to_key}`;
    if (seen.has(id)) {
      throw new ValidationError(
        `Edge (${edge.from_key} -> ${edge.to_key}) is not unique for this workflow`,
      );
    }
    seen.add(id);
  }
}

export function documentToGraphParts(doc: WorkflowDocument): GraphWorkflowParts {
  const edges: GraphEdgePart[] = [];
  for (const stage of doc.stages) {
    const seenTargets = new Set<string>();
    for (const target of stage.transitions) {
      if (seenTargets.has(target)) {
        throw new ValidationError(
          `Edge (${stage.key} -> ${target}) is not unique for this workflow`,
        );
      }
      seenTargets.add(target);
      const rules = getEdgeScopedRules(stage, target);
      edges.push({
        from_key: stage.key,
        to_key: target,
        require_tokens_estimate: rules.require_tokens_estimate,
        require_playbook_description: rules.require_playbook_description,
      });
    }
  }
  assertUniqueGraphEdges(edges);
  return {
    version: typeof doc.version === "number" ? doc.version : 2,
    agent_policy: doc.agent_policy,
    ticket_templates: doc.ticket_templates,
    stages: doc.stages.map((stage, index) => ({
      key: stage.key,
      name: stage.name,
      sort_order: index,
      catalog_key: stage.key,
      agent: stripEdgeScopedAgent(stage.agent),
    })),
    edges,
  };
}

function parseJsonUnknown(raw: string | null | undefined): unknown {
  if (!raw?.trim()) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function assembleGraphToDocument(input: {
  version?: number;
  agent_policy?: unknown;
  agent_policy_json?: string | null;
  ticket_templates?: unknown;
  ticket_templates_json?: string | null;
  stages: Array<{
    key: string;
    name: string;
    sort_order?: number | null;
    agent?: unknown;
    agent_json?: string | null;
  }>;
  edges: Array<{
    from_key: string;
    to_key: string;
    require_tokens_estimate?: boolean | string | null;
    require_playbook_description?: boolean | string | null;
  }>;
}): WorkflowDocument {
  const stagesSorted = [...input.stages].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
  );
  const policyRaw =
    input.agent_policy ?? parseJsonUnknown(input.agent_policy_json);
  const templatesRaw =
    input.ticket_templates ?? parseJsonUnknown(input.ticket_templates_json);
  const parsed = parseWorkflowDocument(
    JSON.stringify({
      version: input.version ?? 2,
      agent_policy: policyRaw,
      ticket_templates: templatesRaw,
      stages: stagesSorted.map((stage) => ({
        key: stage.key,
        name: stage.name,
        transitions: [],
        agent: stage.agent ?? parseJsonUnknown(stage.agent_json),
      })),
    }),
  );
  const graphEdges: WorkflowGraphEdge[] = input.edges.map((edge) => ({
    id: `${edge.from_key}->${edge.to_key}`,
    source: edge.from_key,
    target: edge.to_key,
  }));
  let stages = applyEdgesToStages(parsed.stages, graphEdges);
  for (const edge of input.edges) {
    stages = stages.map((stage) =>
      stage.key === edge.from_key
        ? setEdgeScopedRules(stage, edge.to_key, {
            require_tokens_estimate: edge.require_tokens_estimate === true ||
              edge.require_tokens_estimate === "true",
            require_playbook_description:
              edge.require_playbook_description === true ||
              edge.require_playbook_description === "true",
          })
        : stage,
    );
  }
  return { ...parsed, stages };
}

export function graphPartsSemanticallyEqual(
  left: WorkflowDocument,
  right: WorkflowDocument,
): boolean {
  if (left.stages.length !== right.stages.length) return false;
  for (let i = 0; i < left.stages.length; i += 1) {
    const a = left.stages[i];
    const b = right.stages[i];
    if (a.key !== b.key || a.name !== b.name) return false;
    if (a.transitions.join("\0") !== b.transitions.join("\0")) return false;
    for (const target of a.transitions) {
      const leftRules = getEdgeScopedRules(a, target);
      const rightRules = getEdgeScopedRules(b, target);
      if (
        leftRules.require_tokens_estimate !==
          rightRules.require_tokens_estimate ||
        leftRules.require_playbook_description !==
          rightRules.require_playbook_description
      ) {
        return false;
      }
    }
    const leftAgent = JSON.stringify(stripEdgeScopedAgent(a.agent) ?? {});
    const rightAgent = JSON.stringify(stripEdgeScopedAgent(b.agent) ?? {});
    if (leftAgent !== rightAgent) return false;
  }
  return JSON.stringify(left.agent_policy) === JSON.stringify(right.agent_policy);
}

export function stageRecordSlug(workflowSlug: string, key: string): string {
  return `${workflowSlug}-stage-${key}`;
}

export function edgeRecordSlug(
  workflowSlug: string,
  fromKey: string,
  toKey: string,
): string {
  return `${workflowSlug}-edge-${fromKey}-to-${toKey}`;
}
