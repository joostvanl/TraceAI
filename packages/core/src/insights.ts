import type { TicketResolution } from "./types.js";

export type SearchHitType = "ticket" | "wiki_page";

export type SearchTicketInput = {
  slug: string;
  ticket_key?: string | null;
  title: string;
  description?: string | null;
  stage: string;
  priority?: string | null;
  created_by?: string | null;
  resolution?: string | null;
  stage_entered_at?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  commentBodies?: string[];
  commentAuthors?: string[];
};

export type SearchWikiInput = {
  slug: string;
  title: string;
  body?: string | null;
  updatedAt?: string | null;
};

export type SearchFilters = {
  q?: string;
  type?: SearchHitType | "all";
  stage?: string;
  resolution?: string;
  priority?: string;
  /** Matches ticket created_by or any comment author. */
  created_by?: string;
  /** Inclusive lower bound (ISO) on stage_entered_at / createdAt / updatedAt. */
  from?: string;
  /** Inclusive upper bound (ISO). */
  to?: string;
};

export type SearchHit = {
  type: SearchHitType;
  slug: string;
  title: string;
  snippet: string;
  score: number;
  ticket_key?: string | null;
  stage?: string;
  priority?: string | null;
  resolution?: string | null;
  stage_entered_at?: string | null;
  created_by?: string | null;
};

export type Paginated<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
};

export type InsightsTicketInput = {
  slug: string;
  ticket_key?: string | null;
  title: string;
  stage: string;
  stage_entered_at?: string | null;
  tokens_estimate?: number | null;
  tokens_actual?: number | null;
  resolution?: string | null;
};

export type ThroughputWeek = {
  week: string;
  count: number;
};

export type WipAgeItem = {
  slug: string;
  ticket_key: string | null;
  title: string;
  stage: string;
  stage_entered_at: string | null;
  age_days: number;
};

export type EstimateAccuracySummary = {
  sample_size: number;
  avg_ratio: number | null;
  median_ratio: number | null;
  under_estimate_count: number;
  over_estimate_count: number;
  on_target_count: number;
};

export type ResolutionMixItem = {
  resolution: string;
  count: number;
  percent: number;
};

export type ProjectInsights = {
  done_stage: string;
  throughput_per_week: ThroughputWeek[];
  open_wip: {
    count: number;
    avg_age_days: number | null;
    items: WipAgeItem[];
  };
  estimate_vs_actual: EstimateAccuracySummary;
  resolution_mix: ResolutionMixItem[];
  /** Deferred without durable transition events (TRA-29). Always 0 for now. */
  review_returns: number;
};

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").toLowerCase();
}

function includesQuery(haystack: string, query: string): boolean {
  if (!query) return true;
  return normalizeText(haystack).includes(query);
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function inDateRange(
  candidates: Array<string | null | undefined>,
  from?: string,
  to?: string,
): boolean {
  if (!from && !to) return true;
  const fromT = from ? parseTime(from) : null;
  const toT = to ? parseTime(to) : null;
  for (const candidate of candidates) {
    const t = parseTime(candidate);
    if (t == null) continue;
    if (fromT != null && t < fromT) continue;
    if (toT != null && t > toT) continue;
    return true;
  }
  // If filters are set but no usable timestamps, exclude.
  return false;
}

function snippetAround(
  text: string,
  query: string,
  maxLen = 160,
): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (!query) {
    return cleaned.length <= maxLen
      ? cleaned
      : `${cleaned.slice(0, maxLen - 1)}…`;
  }
  const lower = cleaned.toLowerCase();
  const idx = lower.indexOf(query);
  if (idx < 0) {
    return cleaned.length <= maxLen
      ? cleaned
      : `${cleaned.slice(0, maxLen - 1)}…`;
  }
  const half = Math.floor((maxLen - query.length) / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(cleaned.length, start + maxLen);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < cleaned.length ? "…" : "";
  return `${prefix}${cleaned.slice(start, end)}${suffix}`;
}

function scoreTicket(ticket: SearchTicketInput, query: string): number {
  if (!query) return 1;
  let score = 0;
  const key = normalizeText(ticket.ticket_key);
  const title = normalizeText(ticket.title);
  const desc = normalizeText(ticket.description);
  if (key === query) score += 100;
  else if (key.includes(query)) score += 50;
  if (title === query) score += 40;
  else if (title.includes(query)) score += 25;
  if (desc.includes(query)) score += 10;
  for (const body of ticket.commentBodies ?? []) {
    if (includesQuery(body, query)) score += 5;
  }
  return score;
}

function scoreWiki(page: SearchWikiInput, query: string): number {
  if (!query) return 1;
  let score = 0;
  const title = normalizeText(page.title);
  const body = normalizeText(page.body);
  if (title === query) score += 40;
  else if (title.includes(query)) score += 25;
  if (body.includes(query)) score += 10;
  return score;
}

function ticketMatchesFilters(
  ticket: SearchTicketInput,
  filters: SearchFilters,
): boolean {
  if (filters.stage && ticket.stage !== filters.stage) return false;
  if (filters.resolution && (ticket.resolution ?? "") !== filters.resolution) {
    return false;
  }
  if (filters.priority && (ticket.priority ?? "medium") !== filters.priority) {
    return false;
  }
  if (filters.created_by) {
    const want = normalizeText(filters.created_by);
    const authors = [
      ticket.created_by,
      ...(ticket.commentAuthors ?? []),
    ].map(normalizeText);
    if (!authors.some((a) => a && a.includes(want))) return false;
  }
  if (
    !inDateRange(
      [ticket.stage_entered_at, ticket.createdAt, ticket.updatedAt],
      filters.from,
      filters.to,
    )
  ) {
    return false;
  }
  return true;
}

/**
 * In-memory project search over tickets (+ comments) and wiki pages.
 * Simple substring match — no external search engine.
 */
export function searchProjectContent(input: {
  tickets: SearchTicketInput[];
  wikiPages?: SearchWikiInput[];
  filters?: SearchFilters;
}): SearchHit[] {
  const filters = input.filters ?? {};
  const query = normalizeText(filters.q).trim();
  const type = filters.type ?? "all";
  const hits: SearchHit[] = [];

  if (type === "all" || type === "ticket") {
    for (const ticket of input.tickets) {
      if (!ticketMatchesFilters(ticket, filters)) continue;
      const fields = [
        ticket.ticket_key ?? "",
        ticket.title,
        ticket.description ?? "",
        ...(ticket.commentBodies ?? []),
      ];
      if (query && !fields.some((f) => includesQuery(f, query))) continue;
      const score = scoreTicket(ticket, query);
      if (query && score <= 0) continue;
      const haystack =
        fields.find((f) => includesQuery(f, query)) ?? ticket.title;
      hits.push({
        type: "ticket",
        slug: ticket.slug,
        title: ticket.title,
        snippet: snippetAround(haystack, query),
        score,
        ticket_key: ticket.ticket_key ?? null,
        stage: ticket.stage,
        priority: ticket.priority ?? "medium",
        resolution: ticket.resolution ?? null,
        stage_entered_at: ticket.stage_entered_at ?? null,
        created_by: ticket.created_by ?? null,
      });
    }
  }

  if (type === "all" || type === "wiki_page") {
    // Ticket-only filters do not apply to wiki hits.
    const wikiFiltersActive =
      Boolean(filters.stage) ||
      Boolean(filters.resolution) ||
      Boolean(filters.priority) ||
      Boolean(filters.created_by);
    if (!wikiFiltersActive) {
      for (const page of input.wikiPages ?? []) {
        if (filters.from || filters.to) {
          if (!inDateRange([page.updatedAt], filters.from, filters.to)) {
            continue;
          }
        }
        const fields = [page.title, page.body ?? ""];
        if (query && !fields.some((f) => includesQuery(f, query))) continue;
        const score = scoreWiki(page, query);
        if (query && score <= 0) continue;
        const haystack =
          fields.find((f) => includesQuery(f, query)) ?? page.title;
        hits.push({
          type: "wiki_page",
          slug: page.slug,
          title: page.title,
          snippet: snippetAround(haystack, query),
          score,
        });
      }
    }
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.title.localeCompare(b.title);
  });
  return hits;
}

export function paginateItems<T>(
  items: T[],
  limit = 25,
  offset = 0,
): Paginated<T> {
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit) || 25));
  const safeOffset = Math.max(0, Math.floor(offset) || 0);
  return {
    items: items.slice(safeOffset, safeOffset + safeLimit),
    total: items.length,
    limit: safeLimit,
    offset: safeOffset,
  };
}

/** Newest-first by stage_entered_at (missing timestamps sort last). */
export function sortTicketsNewestFirst<T extends InsightsTicketInput>(
  tickets: T[],
): T[] {
  return [...tickets].sort((a, b) => {
    const ta = parseTime(a.stage_entered_at) ?? 0;
    const tb = parseTime(b.stage_entered_at) ?? 0;
    return tb - ta;
  });
}

function isoWeekKey(date: Date): string {
  // ISO week: Thursday-based year + week number.
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function ageDays(enteredAt: string | null | undefined, now: Date): number {
  const t = parseTime(enteredAt);
  if (t == null) return 0;
  return Math.max(0, (now.getTime() - t) / 86400000);
}

/**
 * Aggregate delivery metrics for a project from ticket fields.
 * `review_returns` is reserved for durable transition events (TRA-29).
 */
export function computeProjectInsights(
  tickets: InsightsTicketInput[],
  options?: {
    doneStageKey?: string;
    now?: Date;
    /** Max WIP items to include in the open_wip list. */
    wipLimit?: number;
  },
): ProjectInsights {
  const doneStage = options?.doneStageKey ?? "done";
  const now = options?.now ?? new Date();
  const wipLimit = options?.wipLimit ?? 25;

  const done = tickets.filter((t) => t.stage === doneStage);
  const open = tickets.filter((t) => t.stage !== doneStage);

  const weekCounts = new Map<string, number>();
  for (const ticket of done) {
    const t = parseTime(ticket.stage_entered_at);
    if (t == null) continue;
    const key = isoWeekKey(new Date(t));
    weekCounts.set(key, (weekCounts.get(key) ?? 0) + 1);
  }
  const throughput_per_week = [...weekCounts.entries()]
    .map(([week, count]) => ({ week, count }))
    .sort((a, b) => a.week.localeCompare(b.week));

  const wipItems: WipAgeItem[] = open
    .map((t) => ({
      slug: t.slug,
      ticket_key: t.ticket_key ?? null,
      title: t.title,
      stage: t.stage,
      stage_entered_at: t.stage_entered_at ?? null,
      age_days: Math.round(ageDays(t.stage_entered_at, now) * 10) / 10,
    }))
    .sort((a, b) => b.age_days - a.age_days);

  const avgAge =
    wipItems.length === 0
      ? null
      : Math.round(
          (wipItems.reduce((sum, i) => sum + i.age_days, 0) / wipItems.length) *
            10,
        ) / 10;

  const withBoth = tickets.filter(
    (t) =>
      typeof t.tokens_estimate === "number" &&
      t.tokens_estimate > 0 &&
      typeof t.tokens_actual === "number" &&
      t.tokens_actual >= 0,
  );
  const ratios = withBoth.map(
    (t) => (t.tokens_actual as number) / (t.tokens_estimate as number),
  );
  let under = 0;
  let over = 0;
  let onTarget = 0;
  for (const ratio of ratios) {
    if (ratio < 0.9) under += 1;
    else if (ratio > 1.1) over += 1;
    else onTarget += 1;
  }
  const avgRatio =
    ratios.length === 0
      ? null
      : Math.round(
          (ratios.reduce((s, r) => s + r, 0) / ratios.length) * 1000,
        ) / 1000;

  const resolutionCounts = new Map<string, number>();
  for (const ticket of done) {
    const key = ticket.resolution ?? "(none)";
    resolutionCounts.set(key, (resolutionCounts.get(key) ?? 0) + 1);
  }
  const doneTotal = done.length || 1;
  const resolution_mix: ResolutionMixItem[] = [...resolutionCounts.entries()]
    .map(([resolution, count]) => ({
      resolution,
      count,
      percent: Math.round((count / doneTotal) * 1000) / 10,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    done_stage: doneStage,
    throughput_per_week,
    open_wip: {
      count: open.length,
      avg_age_days: avgAge,
      items: wipItems.slice(0, wipLimit),
    },
    estimate_vs_actual: {
      sample_size: withBoth.length,
      avg_ratio: avgRatio,
      median_ratio:
        ratios.length === 0
          ? null
          : Math.round((median(ratios) as number) * 1000) / 1000,
      under_estimate_count: under,
      over_estimate_count: over,
      on_target_count: onTarget,
    },
    resolution_mix,
    review_returns: 0,
  };
}

/** Exported for tests — known resolution keys. */
export const INSIGHTS_RESOLUTION_KEYS: readonly TicketResolution[] = [
  "completed",
  "superseded",
  "cancelled",
  "duplicate",
  "verification-only",
] as const;
