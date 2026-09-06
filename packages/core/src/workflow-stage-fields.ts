import { relationSlug } from "./relations.js";
import type { WorkflowStageAgentRules } from "./types.js";
import {
  resolveGraphEdgeEndpointKey,
  stageSlugForEdgeEndpoint,
  type GraphStageEndpoint,
} from "./workflow-graph.js";

export function parseLineList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item).trim()).filter(Boolean);
    return items.length ? items : undefined;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const items = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

export function formatLineList(items: string[] | undefined): string {
  return (items ?? []).map((item) => item.trim()).filter(Boolean).join("\n");
}

export function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

function relationItems(value: unknown): unknown[] {
  if (value == null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

export function resolveOptionalStageKey(
  relation: unknown,
  stages: GraphStageEndpoint[],
): string | undefined {
  const first = relationItems(relation)[0];
  if (first == null || first === "") return undefined;
  if (typeof first === "string" && !first.trim()) return undefined;
  if (!relationSlug(first) && typeof first !== "object") return undefined;
  return resolveGraphEdgeEndpointKey(first, stages);
}

export function resolveStageKeyList(
  relations: unknown,
  stages: GraphStageEndpoint[],
): string[] | undefined {
  const keys = relationItems(relations)
    .map((item) => {
      if (item == null || item === "") return "";
      return resolveGraphEdgeEndpointKey(item, stages);
    })
    .filter(Boolean);
  return keys.length ? keys : undefined;
}

export type StageAgentRecordFields = {
  purpose?: string | null;
  on_enter?: string | null;
  on_exit?: string | null;
  require_comment_on_enter?: boolean | string | null;
  require_comment_on_exit?: boolean | string | null;
  require_comment_sections_on_enter?: string | null;
  require_comment_sections_on_exit?: string | null;
  require_comment_sections_on_reject?: string | null;
  require_comment_sections_on_dismiss?: string | null;
  comment_template?: string | null;
  require_resolution_on_enter?: boolean | string | null;
  require_human_approval_on_exit?: boolean | string | null;
  human_approve_to?: unknown;
  human_dismiss_to?: unknown;
  human_reject_to?: unknown;
};

export function stageRecordToAgent(
  fields: StageAgentRecordFields,
  stages: GraphStageEndpoint[],
): WorkflowStageAgentRules | undefined {
  const agent: WorkflowStageAgentRules = {
    purpose: fields.purpose?.trim() || undefined,
    on_enter: parseLineList(fields.on_enter),
    on_exit: parseLineList(fields.on_exit),
    require_comment_on_enter:
      parseOptionalBoolean(fields.require_comment_on_enter) === true
        ? true
        : undefined,
    require_comment_on_exit:
      parseOptionalBoolean(fields.require_comment_on_exit) === true
        ? true
        : undefined,
    require_comment_sections_on_enter: parseLineList(
      fields.require_comment_sections_on_enter,
    ),
    require_comment_sections_on_exit: parseLineList(
      fields.require_comment_sections_on_exit,
    ),
    require_comment_sections_on_reject: parseLineList(
      fields.require_comment_sections_on_reject,
    ),
    require_comment_sections_on_dismiss: parseLineList(
      fields.require_comment_sections_on_dismiss,
    ),
    comment_template: fields.comment_template?.trim() || undefined,
    require_resolution_on_enter:
      parseOptionalBoolean(fields.require_resolution_on_enter) === true
        ? true
        : undefined,
    require_human_approval_on_exit:
      parseOptionalBoolean(fields.require_human_approval_on_exit) === true
        ? true
        : undefined,
    human_approve_to: resolveOptionalStageKey(fields.human_approve_to, stages),
    human_dismiss_to: resolveOptionalStageKey(fields.human_dismiss_to, stages),
    human_reject_to: resolveStageKeyList(fields.human_reject_to, stages),
  };
  return Object.values(agent).some((value) => value !== undefined)
    ? agent
    : undefined;
}

export function agentToStageRecordFields(
  agent: WorkflowStageAgentRules | undefined,
  stages: GraphStageEndpoint[],
): Record<string, string | boolean | string[]> {
  return {
    purpose: agent?.purpose?.trim() ?? "",
    on_enter: formatLineList(agent?.on_enter),
    on_exit: formatLineList(agent?.on_exit),
    require_comment_on_enter: agent?.require_comment_on_enter === true,
    require_comment_on_exit: agent?.require_comment_on_exit === true,
    require_comment_sections_on_enter: formatLineList(
      agent?.require_comment_sections_on_enter,
    ),
    require_comment_sections_on_exit: formatLineList(
      agent?.require_comment_sections_on_exit,
    ),
    require_comment_sections_on_reject: formatLineList(
      agent?.require_comment_sections_on_reject,
    ),
    require_comment_sections_on_dismiss: formatLineList(
      agent?.require_comment_sections_on_dismiss,
    ),
    comment_template: agent?.comment_template?.trim() ?? "",
    require_resolution_on_enter: agent?.require_resolution_on_enter === true,
    require_human_approval_on_exit: agent?.require_human_approval_on_exit === true,
    human_approve_to: agent?.human_approve_to
      ? stageSlugForEdgeEndpoint(agent.human_approve_to, stages)
      : "",
    human_dismiss_to: agent?.human_dismiss_to
      ? stageSlugForEdgeEndpoint(agent.human_dismiss_to, stages)
      : "",
    human_reject_to: (agent?.human_reject_to ?? []).map((key) =>
      stageSlugForEdgeEndpoint(key, stages),
    ),
  };
}
