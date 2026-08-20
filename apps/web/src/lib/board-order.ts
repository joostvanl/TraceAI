export type BoardOrderTicket = {
  slug: string;
  stage: string;
  sortOrder?: number | null;
  orphan?: boolean;
};

export type BoardOrderStage = {
  key: string;
};

/** Move `fromIndex` item to `toIndex` within a list (immutable). */
export function moveItem<T>(list: T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= list.length ||
    toIndex >= list.length
  ) {
    return list;
  }
  const next = [...list];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item!);
  return next;
}

/**
 * Group tickets by stage. When `reorderableStageKey` is set, that column is
 * sorted ascending by `sortOrder` (stable slug tie-break). Callers that need
 * Done newest-first capping should apply that after grouping.
 */
export function groupByStage<T extends BoardOrderTicket>(
  stages: BoardOrderStage[],
  tickets: T[],
  reorderableStageKey?: string,
): Record<string, T[]> {
  const map: Record<string, T[]> = {};
  for (const stage of stages) map[stage.key] = [];
  for (const ticket of tickets) {
    if (!map[ticket.stage]) map[ticket.stage] = [];
    map[ticket.stage].push(ticket);
  }
  if (reorderableStageKey && map[reorderableStageKey]) {
    map[reorderableStageKey] = [...map[reorderableStageKey]].sort((a, b) => {
      const aOrphan = Boolean(a.orphan);
      const bOrphan = Boolean(b.orphan);
      if (aOrphan !== bOrphan) return aOrphan ? 1 : -1;
      const ao = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const bo = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return a.slug.localeCompare(b.slug);
    });
  }
  return map;
}
