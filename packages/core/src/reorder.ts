import { ValidationError } from "./trace-errors.js";

/** Shared validation for ticket `sort_order` writes. */
export function assertNonNegativeIntegerSortOrder(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError("sort_order must be a non-negative integer");
  }
}

export type ReorderableTicket = {
  slug: string;
  project: string;
  stage: string;
  workflow: string;
  sort_order?: number | null;
};

export type SortOrderUpdate = {
  slug: string;
  sort_order: number;
};

/**
 * Plan `sort_order` updates for a full permutation of tickets in one
 * project stage. Rejects slugs outside the stage/project and incomplete lists.
 */
export function planTicketReorder(input: {
  project: string;
  stage: string;
  workflow: string;
  ordered_slugs: string[];
  tickets: ReorderableTicket[];
}): SortOrderUpdate[] {
  const { project, stage, workflow, ordered_slugs } = input;
  if (!workflow) {
    throw new ValidationError("workflow is required");
  }
  if (!Array.isArray(ordered_slugs) || ordered_slugs.length === 0) {
    throw new ValidationError("ordered_slugs must be a non-empty array");
  }
  if (new Set(ordered_slugs).size !== ordered_slugs.length) {
    throw new ValidationError("ordered_slugs must not contain duplicates");
  }

  const inStage = input.tickets.filter(
    (t) =>
      t.project === project && t.stage === stage && t.workflow === workflow,
  );
  const bySlug = new Map(inStage.map((t) => [t.slug, t]));

  for (const slug of ordered_slugs) {
    if (!bySlug.has(slug)) {
      throw new ValidationError(
        `Ticket not in project "${project}" stage "${stage}": ${slug}`,
      );
    }
  }

  if (ordered_slugs.length !== inStage.length) {
    throw new ValidationError(
      `ordered_slugs must include every ticket in stage "${stage}" (${inStage.length} expected, got ${ordered_slugs.length})`,
    );
  }

  const updates: SortOrderUpdate[] = [];
  ordered_slugs.forEach((slug, index) => {
    const current = bySlug.get(slug)!;
    if ((current.sort_order ?? 0) !== index) {
      updates.push({ slug, sort_order: index });
    }
  });
  return updates;
}
