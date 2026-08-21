/** Synthetic column for tickets whose stage is not in the live workflow. */
export const UNMAPPED_STAGE_KEY = "__unmapped__";

/**
 * A card belongs on the selected board when the pin matches, or — only on
 * the project's default board — when the pin is empty, unknown, or not in
 * that project's workflow list (wees-pins). No writes.
 */
export function ticketBelongsOnBoard(input: {
  ticketWorkflow: string | null | undefined;
  selectedWorkflow: string;
  defaultWorkflow: string | null | undefined;
  projectWorkflowSlugs: Iterable<string>;
}): boolean {
  const pin = input.ticketWorkflow || "";
  if (pin === input.selectedWorkflow) return true;
  if (
    !input.defaultWorkflow ||
    input.selectedWorkflow !== input.defaultWorkflow
  ) {
    return false;
  }
  if (!pin) return true;
  const owned = new Set(input.projectWorkflowSlugs);
  return !owned.has(pin);
}

/** Map unknown live stage keys to the overflow column for rendering only. */
export function remapStageForBoard(
  stage: string,
  liveStageKeys: Iterable<string>,
): string {
  const keys = liveStageKeys instanceof Set ? liveStageKeys : new Set(liveStageKeys);
  return keys.has(stage) ? stage : UNMAPPED_STAGE_KEY;
}

/**
 * Pin-wissel (TRA-95) is allowed only on a real project workflow whose live
 * first stage matches the ticket. Wees-pins (empty / unknown / foreign) cannot
 * be rescued this way.
 */
export function isTicketWorkflowReassignable(input: {
  currentPin: string | null | undefined;
  currentStage: string;
  liveFirstStageKey: string | null | undefined;
  defaultWorkflow: string | null | undefined;
  projectWorkflowSlugs: Iterable<string>;
}): boolean {
  const pin = input.currentPin?.trim() || "";
  if (!isProjectWorkflow(pin, input.defaultWorkflow, input.projectWorkflowSlugs)) {
    return false;
  }
  if (!input.liveFirstStageKey) return false;
  return input.currentStage === input.liveFirstStageKey;
}

/** Next `sort_order` for a column: max existing + 1, or 0 when empty. */
export function nextColumnSortOrder(
  sortOrders: Iterable<number | null | undefined>,
): number {
  let max = -1;
  for (const n of sortOrders) {
    if (typeof n === "number" && Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

export function workflowReassignAuditComment(
  oldName: string,
  newName: string,
): string {
  return `Workflow: ${oldName} → ${newName}`;
}

/** Create may pin default_workflow or a live workflow of this project only. */
export function isProjectWorkflow(
  workflowSlug: string,
  defaultWorkflow: string | null | undefined,
  projectWorkflowSlugs: Iterable<string>,
): boolean {
  if (!workflowSlug) return false;
  if (defaultWorkflow && workflowSlug === defaultWorkflow) return true;
  for (const slug of projectWorkflowSlugs) {
    if (slug === workflowSlug) return true;
  }
  return false;
}

/**
 * Settings editor URL: omit `workflow=` → default; unknown/foreign → null (404).
 */
export function editorWorkflowSlugForRequest(input: {
  requested: string | null | undefined;
  defaultWorkflow: string | null | undefined;
  projectWorkflowSlugs: Iterable<string>;
}): string | null {
  const requested = input.requested?.trim() || "";
  if (!requested) return input.defaultWorkflow || null;
  if (
    !isProjectWorkflow(
      requested,
      input.defaultWorkflow,
      input.projectWorkflowSlugs,
    )
  ) {
    return null;
  }
  return requested;
}
