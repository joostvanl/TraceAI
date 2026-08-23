/**
 * Agent transition hard-stop while a human gate is still open (TRA-102).
 * HTTP 409, same family as STAGE_CONFLICT — not 400 (retryable) or 403 (identity).
 */
import {
  humanApproveTarget,
  humanDismissTarget,
  humanRejectTargets,
  isTicketReviewState,
  reviewVerdictTarget,
  type WorkflowStage,
} from "./types.js";

export const HUMAN_GATE_OPEN = "HUMAN_GATE_OPEN";

export class HumanGateOpenError extends Error {
  readonly code = HUMAN_GATE_OPEN;
  readonly status = 409;

  constructor(
    readonly current_stage: string,
    readonly review_state: string | null,
    readonly to_stage: string,
    readonly allowed_targets: string[],
    message: string,
  ) {
    super(message);
    this.name = "HumanGateOpenError";
  }
}

export function humanGateAllowedTargets(stage: WorkflowStage): string[] {
  const targets: string[] = [];
  const approve = humanApproveTarget(stage);
  if (approve) targets.push(approve);
  for (const key of humanRejectTargets(stage)) {
    if (!targets.includes(key)) targets.push(key);
  }
  const dismiss = humanDismissTarget(stage);
  if (dismiss && !targets.includes(dismiss)) targets.push(dismiss);
  return targets;
}

export function isLegalHumanVerdictEdge(
  fromStage: WorkflowStage,
  toKey: string,
): boolean {
  if (fromStage.agent?.require_human_approval_on_exit !== true) return false;
  return humanGateAllowedTargets(fromStage).includes(toKey);
}

function stageIndex(stages: WorkflowStage[], key: string): number {
  return stages.findIndex((s) => s.key === key);
}

/** Later board-order keys (exclusive). Used so wrap-around paths do not count as skips. */
function laterKeys(stages: WorkflowStage[], fromKey: string): Set<string> {
  const index = stageIndex(stages, fromKey);
  if (index < 0) return new Set();
  return new Set(stages.slice(index + 1).map((s) => s.key));
}

function reachableForward(
  stages: WorkflowStage[],
  fromKey: string,
  toKey: string,
  excludeEdge?: readonly [string, string],
): boolean {
  if (fromKey === toKey) return true;
  const byKey = new Map(stages.map((s) => [s.key, s]));
  const allowed = new Set(laterKeys(stages, fromKey));
  allowed.add(toKey);
  const seen = new Set<string>();
  const queue = [fromKey];
  while (queue.length) {
    const key = queue.shift()!;
    if (seen.has(key)) continue;
    seen.add(key);
    const stage = byKey.get(key);
    if (!stage) continue;
    for (const next of stage.transitions) {
      if (excludeEdge && excludeEdge[0] === key && excludeEdge[1] === next) {
        continue;
      }
      if (!allowed.has(next)) continue;
      if (next === toKey) return true;
      if (!seen.has(next)) queue.push(next);
    }
  }
  return false;
}

/**
 * Human-gated stages in board order strictly between `fromKey` and `toKey`
 * that lie on a forward path. Backward edges (to an earlier column) never skip.
 */
export function skippedHumanGatedStages(
  stages: WorkflowStage[],
  fromKey: string,
  toKey: string,
): string[] {
  const fromIndex = stageIndex(stages, fromKey);
  const toIndex = stageIndex(stages, toKey);
  if (fromIndex < 0 || toIndex < 0 || toIndex <= fromIndex) return [];
  const skipped: string[] = [];
  for (const stage of stages) {
    if (stage.agent?.require_human_approval_on_exit !== true) continue;
    const index = stageIndex(stages, stage.key);
    if (index <= fromIndex || index >= toIndex) continue;
    if (
      reachableForward(stages, fromKey, stage.key, [fromKey, toKey]) &&
      reachableForward(stages, stage.key, toKey, [fromKey, toKey])
    ) {
      skipped.push(stage.key);
    }
  }
  return skipped;
}

function normalizeReview(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  return value;
}

/**
 * Agent-only. `asHuman` (board UI) is exempt. Legal verdict edges are never skips.
 */
export function assertHumanGateTransition(input: {
  stages: WorkflowStage[];
  fromStage: WorkflowStage;
  toStage: WorkflowStage;
  asHuman?: boolean;
  reviewState?: string | null;
}): void {
  if (input.asHuman === true) return;
  if (input.fromStage.key === input.toStage.key) return;

  const reviewState = normalizeReview(input.reviewState);

  if (input.fromStage.agent?.require_human_approval_on_exit === true) {
    const allowed = humanGateAllowedTargets(input.fromStage);
    if (!isTicketReviewState(reviewState)) {
      throw new HumanGateOpenError(
        input.fromStage.key,
        null,
        input.toStage.key,
        allowed,
        `Stage "${input.fromStage.key}" is waiting for a human review verdict. Ask the reviewer to use Goedkeuren/Afkeuren/Afzien in the TraceAI UI, then transition on the back of that verdict. Do not retry this transition. Do not omit expected_stage or expected_review_state to bypass the gate.`,
      );
    }
    const allowedNow = reviewVerdictTarget(input.fromStage, reviewState);
    if (allowedNow !== input.toStage.key) {
      throw new HumanGateOpenError(
        input.fromStage.key,
        reviewState,
        input.toStage.key,
        allowedNow ? [allowedNow] : [],
        `The human verdict on "${input.fromStage.key}" is "${reviewState}", so this ticket may only move to "${allowedNow ?? "(no target configured)"}" — not "${input.toStage.key}". Do not retry this transition.`,
      );
    }
    return;
  }

  const skipped = skippedHumanGatedStages(
    input.stages,
    input.fromStage.key,
    input.toStage.key,
  );
  if (skipped.length === 0) return;
  throw new HumanGateOpenError(
    input.fromStage.key,
    reviewState,
    input.toStage.key,
    [],
    `Transition from "${input.fromStage.key}" to "${input.toStage.key}" skips human-gated stage(s): ${skipped.join(", ")}. Wait for a UI verdict on that gate. Do not retry this transition.`,
  );
}
