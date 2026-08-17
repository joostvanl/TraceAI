/** Shared validation for ticket `sort_order` writes. */
export function assertNonNegativeIntegerSortOrder(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("sort_order must be a non-negative integer");
  }
}

export type ReorderableTicket = {
  slug: string;
  project: string;
  stage: string;
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
  ordered_slugs: string[];
  tickets: ReorderableTicket[];
}): SortOrderUpdate[] {
  const { project, stage, ordered_slugs } = input;
  if (!Array.isArray(ordered_slugs) || ordered_slugs.length === 0) {
    throw new Error("ordered_slugs must be a non-empty array");
  }
  if (new Set(ordered_slugs).size !== ordered_slugs.length) {
    throw new Error("ordered_slugs must not contain duplicates");
  }

  const inStage = input.tickets.filter(
    (t) => t.project === project && t.stage === stage,
  );
  const bySlug = new Map(inStage.map((t) => [t.slug, t]));

  for (const slug of ordered_slugs) {
    if (!bySlug.has(slug)) {
      throw new Error(
        `Ticket not in project "${project}" stage "${stage}": ${slug}`,
      );
    }
  }

  if (ordered_slugs.length !== inStage.length) {
    throw new Error(
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
