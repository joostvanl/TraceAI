import {
  paginateItems,
  searchProjectContent,
  sortTicketsNewestFirst,
  type Paginated,
} from "@traceai/core";

export const TICKETS_PAGE_SIZE = 25;

export const TICKET_LIST_PRIORITIES = ["low", "medium", "high"] as const;

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
};

function one(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function parseTicketListQuery(
  searchParams: Record<string, string | string[] | undefined>,
): TicketListQuery {
  const offsetRaw = Number(one(searchParams.offset) ?? 0);
  return {
    q: one(searchParams.q)?.trim() ?? "",
    workflow: one(searchParams.workflow)?.trim() ?? "",
    stage: one(searchParams.stage)?.trim() ?? "",
    priority: one(searchParams.priority)?.trim() ?? "",
    resolution: one(searchParams.resolution)?.trim() ?? "",
    offset:
      Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0,
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
  if (offset > 0) params.set("offset", String(offset));
  const qs = params.toString();
  return qs
    ? `/projects/${projectSlug}/tickets?${qs}`
    : `/projects/${projectSlug}/tickets`;
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

export function orderTicketsForList(
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

export function pageTicketList(
  tickets: TicketListInput[],
  query: TicketListQuery,
): Paginated<TicketListInput> {
  const filtered = filterTicketsByMeta(tickets, query);
  const ordered = orderTicketsForList(filtered, query.q);
  return paginateItems(ordered, TICKETS_PAGE_SIZE, query.offset);
}
