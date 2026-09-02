import { UNMAPPED_STAGE_KEY } from "@traceai/core";

/** Column is "in behandeling": not a Human Gate, not Done, not overflow. */
export function isActiveWorkStage(input: {
  stageKey: string;
  requiresHumanApproval: boolean;
  lastStageKey?: string;
}): boolean {
  if (input.requiresHumanApproval === true) return false;
  if (input.lastStageKey && input.stageKey === input.lastStageKey) return false;
  if (input.stageKey === UNMAPPED_STAGE_KEY) return false;
  return true;
}
