import {
  paginateItems,
  searchProjectContent,
  sortTicketsNewestFirst,
  type Paginated,
} from "@traceai/core";

export const TICKETS_PAGE_SIZE = 25;

export const TICKET_LIST_PRIORITIES = ["low", "medium", "high"] as const;

export const TICKET_LIST_SORTS = [
  "key",
  "title",
  "workflow",
  "stage",
  "priority",
  "tokens",
  "entered",
] as const;

export const TICKET_LIST_DIRS = ["asc", "desc"] as const;

export type TicketListSort = (typeof TICKET_LIST_SORTS)[number];
export type TicketListDir = (typeof TICKET_LIST_DIRS)[number];

export type TicketListInput = {
  slug: string;
  ticket_key: string | null;
  title: string;
  workflow: string;
  stage: string;
  priority: string;
  tokens_estimate: number | null;
  tokens_actual: number | null;
  stage_entered_at: string | null;
  resolution: string | null;
  description?: string;
  commentBodies?: string[];
};

export type TicketListQuery = {
  q: string;
  workflow: string;
  stage: string;
  priority: string;
  resolution: string;
  offset: number;
  sort: TicketListSort | "";
  dir: TicketListDir | "";
};

const SORT_SET = new Set<string>(TICKET_LIST_SORTS);
const PRIORITY_RANK: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

function one(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function defaultDirForSort(sort: TicketListSort): TicketListDir {
  return sort === "tokens" || sort === "entered" ? "desc" : "asc";
}

function parseSort(raw: string | undefined): TicketListSort | "" {
  const value = raw?.trim() ?? "";
  return SORT_SET.has(value) ? (value as TicketListSort) : "";
}

function parseDir(
  raw: string | undefined,
  sort: TicketListSort | "",
): TicketListDir | "" {
  if (!sort) return "";
  const value = raw?.trim() ?? "";
  if (value === "asc" || value === "desc") return value;
  return defaultDirForSort(sort);
}

export function parseTicketListQuery(
  searchParams: Record<string, string | string[] | undefined>,
): TicketListQuery {
  const offsetRaw = Number(one(searchParams.offset) ?? 0);
  const sort = parseSort(one(searchParams.sort));
  return {
    q: one(searchParams.q)?.trim() ?? "",
    workflow: one(searchParams.workflow)?.trim() ?? "",
    stage: one(searchParams.stage)?.trim() ?? "",
    priority: one(searchParams.priority)?.trim() ?? "",
    resolution: one(searchParams.resolution)?.trim() ?? "",
    offset:
      Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0,
    sort,
    dir: parseDir(one(searchParams.dir), sort),
  };
}

export function ticketListHref(
  projectSlug: string,
  query: TicketListQuery,
  offset = query.offset,
): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.workflow) params.set("workflow", query.workflow);
  if (query.stage) params.set("stage", query.stage);
  if (query.priority) params.set("priority", query.priority);
  if (query.resolution) params.set("resolution", query.resolution);
  if (query.sort) {
    params.set("sort", query.sort);
    params.set("dir", query.dir || defaultDirForSort(query.sort));
  }
  if (offset > 0) params.set("offset", String(offset));
  const qs = params.toString();
  return qs
    ? `/projects/${projectSlug}/tickets?${qs}`
    : `/projects/${projectSlug}/tickets`;
}

export function nextTicketListSort(
  query: TicketListQuery,
  column: TicketListSort,
): { sort: TicketListSort; dir: TicketListDir } {
  if (query.sort === column) {
    const current = query.dir || defaultDirForSort(column);
    return { sort: column, dir: current === "asc" ? "desc" : "asc" };
  }
  return { sort: column, dir: defaultDirForSort(column) };
}

export function ticketListColumnHref(
  projectSlug: string,
  query: TicketListQuery,
  column: TicketListSort,
): string {
  const next = nextTicketListSort(query, column);
  return ticketListHref(
    projectSlug,
    { ...query, sort: next.sort, dir: next.dir },
    0,
  );
}

export function columnAriaSort(
  query: TicketListQuery,
  column: TicketListSort,
): "ascending" | "descending" | "none" {
  if (query.sort !== column) return "none";
  return query.dir === "desc" ? "descending" : "ascending";
}

export function uniqueStageKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    const trimmed = key.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function formatTokens(
  estimate: number | null,
  actual: number | null,
): string {
  if (estimate == null && actual == null) return "—";
  return `${estimate ?? "—"} / ${actual ?? "—"}`;
}

export function formatEntered(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

export function filterTicketsByMeta(
  tickets: TicketListInput[],
  query: Pick<TicketListQuery, "workflow" | "stage" | "priority" | "resolution">,
): TicketListInput[] {
  return tickets.filter((ticket) => {
    if (query.workflow && ticket.workflow !== query.workflow) return false;
    if (query.stage && ticket.stage !== query.stage) return false;
    if (query.priority && ticket.priority !== query.priority) return false;
    if (query.resolution && (ticket.resolution ?? "") !== query.resolution) {
      return false;
    }
    return true;
  });
}

function ticketKeyNumber(key: string | null): number | null {
  if (!key) return null;
  const match = key.match(/(\d+)\s*$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function compareNullableNumber(
  a: number | null,
  b: number | null,
  dir: TicketListDir,
): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const cmp = a - b;
  return dir === "desc" ? -cmp : cmp;
}

function compareString(a: string, b: string, dir: TicketListDir): number {
  const cmp = a.localeCompare(b, undefined, { sensitivity: "base" });
  return dir === "desc" ? -cmp : cmp;
}

export function sortTicketsByColumn(
  tickets: TicketListInput[],
  sort: TicketListSort,
  dir: TicketListDir,
): TicketListInput[] {
  return [...tickets].sort((a, b) => {
    switch (sort) {
      case "key": {
        const numbered = compareNullableNumber(
          ticketKeyNumber(a.ticket_key),
          ticketKeyNumber(b.ticket_key),
          dir,
        );
        if (numbered !== 0) return numbered;
        return compareString(a.ticket_key ?? "", b.ticket_key ?? "", dir);
      }
      case "title":
        return compareString(a.title, b.title, dir);
      case "workflow":
        return compareString(a.workflow, b.workflow, dir);
      case "stage":
        return compareString(a.stage, b.stage, dir);
      case "priority":
        return compareNullableNumber(
          PRIORITY_RANK[a.priority] ?? null,
          PRIORITY_RANK[b.priority] ?? null,
          dir,
        );
      case "tokens": {
        const actual = compareNullableNumber(
          a.tokens_actual,
          b.tokens_actual,
          dir,
        );
        if (actual !== 0) return actual;
        return compareNullableNumber(
          a.tokens_estimate,
          b.tokens_estimate,
          dir,
        );
      }
      case "entered": {
        const ta = a.stage_entered_at
          ? Date.parse(a.stage_entered_at)
          : Number.NaN;
        const tb = b.stage_entered_at
          ? Date.parse(b.stage_entered_at)
          : Number.NaN;
        return compareNullableNumber(
          Number.isFinite(ta) ? ta : null,
          Number.isFinite(tb) ? tb : null,
          dir,
        );
      }
    }
  });
}

function rankTicketsForQuery(
  tickets: TicketListInput[],
  q: string,
): TicketListInput[] {
  if (!q) return sortTicketsNewestFirst(tickets);
  const hits = searchProjectContent({
    tickets: tickets.map((ticket) => ({
      slug: ticket.slug,
      ticket_key: ticket.ticket_key,
      title: ticket.title,
      description: ticket.description ?? "",
      stage: ticket.stage,
      priority: ticket.priority,
      resolution: ticket.resolution,
      stage_entered_at: ticket.stage_entered_at,
      commentBodies: ticket.commentBodies ?? [],
    })),
    wikiPages: [],
    filters: { q, type: "ticket" },
  });
  const bySlug = new Map(tickets.map((ticket) => [ticket.slug, ticket]));
  return hits.flatMap((hit) => {
    if (hit.type !== "ticket") return [];
    const row = bySlug.get(hit.slug);
    return row ? [row] : [];
  });
}

export function orderTicketsForList(
  tickets: TicketListInput[],
  query: Pick<TicketListQuery, "q" | "sort" | "dir"> | string,
): TicketListInput[] {
  const q = typeof query === "string" ? query : query.q;
  const sort = typeof query === "string" ? "" : query.sort;
  const dir = typeof query === "string" ? "" : query.dir;
  const ranked = rankTicketsForQuery(tickets, q);
  if (!sort) return ranked;
  return sortTicketsByColumn(
    ranked,
    sort,
    dir || defaultDirForSort(sort),
  );
}

export function pageTicketList(
  tickets: TicketListInput[],
  query: TicketListQuery,
): Paginated<TicketListInput> {
  const filtered = filterTicketsByMeta(tickets, query);
  const ordered = orderTicketsForList(filtered, query);
  return paginateItems(ordered, TICKETS_PAGE_SIZE, query.offset);
}
