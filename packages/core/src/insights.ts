import type { TicketResolution } from "./types.js";
import { ValidationError } from "./trace-errors.js";
import {
  searchIndexedContent,
  type SearchFilters,
  type SearchHit,
  type SearchOptions,
  type SearchTicketInput,
  type SearchWikiInput,
} from "./search-index.js";
export type {
  SearchFilters,
  SearchHit,
  SearchHitType,
  SearchOptions,
  SearchProfile,
  SearchTicketInput,
  SearchWikiInput,
} from "./search-index.js";

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

export const DEFAULT_ESTIMATE_LIMIT = 50;
export const DEFAULT_ESTIMATE_BREAKPOINTS: readonly number[] = [20000, 80000];
export const MAX_ESTIMATE_LIMIT = 200;
export const MAX_BREAKPOINTS = 8;

export type EstimateAccuracyExtended = EstimateAccuracySummary & {
  avg_estimate: number | null;
  avg_actual: number | null;
  median_actual: number | null;
};

export type EstimateVsActualSegment = EstimateAccuracyExtended & {
  label: string;
  min_actual: number | null;
  max_actual: number | null;
  max_exclusive: boolean;
};

export type EstimateVsActualWindow = {
  eligible_total: number;
  sample_size: number;
  newest_entered_at: string | null;
  oldest_entered_at: string | null;
};

export type EstimateVsActualResult = {
  done_stage: string;
  limit: number;
  breakpoints: number[];
  window: EstimateVsActualWindow;
  overall: EstimateAccuracyExtended;
  segments: EstimateVsActualSegment[];
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

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

export function searchProjectContent(input: {
  tickets: SearchTicketInput[];
  wikiPages?: SearchWikiInput[];
  filters?: SearchFilters;
  options?: SearchOptions;
}): SearchHit[] {
  return searchIndexedContent(input).hits;
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

function hasComparableTokens(ticket: InsightsTicketInput): boolean {
  return (
    typeof ticket.tokens_estimate === "number" &&
    ticket.tokens_estimate > 0 &&
    typeof ticket.tokens_actual === "number" &&
    ticket.tokens_actual >= 0
  );
}

function roundRatio(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function accuracyExtended(
  tickets: InsightsTicketInput[],
): EstimateAccuracyExtended {
  if (tickets.length === 0) {
    return {
      sample_size: 0,
      avg_ratio: null,
      median_ratio: null,
      under_estimate_count: 0,
      over_estimate_count: 0,
      on_target_count: 0,
      avg_estimate: null,
      avg_actual: null,
      median_actual: null,
    };
  }
  const estimates = tickets.map((t) => t.tokens_estimate as number);
  const actuals = tickets.map((t) => t.tokens_actual as number);
  const ratios = tickets.map(
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
  return {
    sample_size: tickets.length,
    avg_ratio: roundRatio(ratios.reduce((sum, r) => sum + r, 0) / ratios.length),
    median_ratio: roundRatio(median(ratios) as number),
    under_estimate_count: under,
    over_estimate_count: over,
    on_target_count: onTarget,
    avg_estimate: Math.round(
      estimates.reduce((sum, n) => sum + n, 0) / estimates.length,
    ),
    avg_actual: Math.round(actuals.reduce((sum, n) => sum + n, 0) / actuals.length),
    median_actual: Math.round(median(actuals) as number),
  };
}

export function resolveEstimateLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_ESTIMATE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ESTIMATE_LIMIT) {
    throw new ValidationError(
      `limit must be an integer between 1 and ${MAX_ESTIMATE_LIMIT}`,
    );
  }
  return limit;
}

export function resolveEstimateBreakpoints(breakpoints?: number[]): number[] {
  if (breakpoints === undefined) {
    return [...DEFAULT_ESTIMATE_BREAKPOINTS];
  }
  if (
    breakpoints.length === 0 ||
    breakpoints.length > MAX_BREAKPOINTS ||
    breakpoints.some(
      (value, index) =>
        !Number.isInteger(value) ||
        value <= 0 ||
        (index > 0 && value <= breakpoints[index - 1]!),
    )
  ) {
    throw new ValidationError(
      "breakpoints must be 1–8 strictly increasing positive integers",
    );
  }
  return breakpoints;
}

function segmentSpecs(breakpoints: number[]): Array<{
  label: string;
  min_actual: number | null;
  max_actual: number | null;
  max_exclusive: boolean;
}> {
  const specs: Array<{
    label: string;
    min_actual: number | null;
    max_actual: number | null;
    max_exclusive: boolean;
  }> = [
    {
      label: `< ${breakpoints[0]}`,
      min_actual: null,
      max_actual: breakpoints[0]!,
      max_exclusive: true,
    },
  ];
  for (let i = 1; i < breakpoints.length; i++) {
    const min = breakpoints[i - 1]!;
    const max = breakpoints[i]!;
    specs.push({
      label: `${min}–${max}`,
      min_actual: min,
      max_actual: max,
      max_exclusive: true,
    });
  }
  const last = breakpoints[breakpoints.length - 1]!;
  specs.push({
    label: `>= ${last}`,
    min_actual: last,
    max_actual: null,
    max_exclusive: false,
  });
  return specs;
}

function bucketIndex(actual: number, breakpoints: number[]): number {
  for (let i = 0; i < breakpoints.length; i++) {
    if (actual < breakpoints[i]!) return i;
  }
  return breakpoints.length;
}

/**
 * Estimate vs actual for the most recent comparable Done tickets, sliced by
 * tokens_actual breakpoints. Separate from computeProjectInsights (TRA-106).
 */
export function computeEstimateVsActual(
  tickets: InsightsTicketInput[],
  options?: {
    doneStageKey?: string;
    limit?: number;
    breakpoints?: number[];
  },
): EstimateVsActualResult {
  const doneStage = options?.doneStageKey ?? "done";
  const limit = resolveEstimateLimit(options?.limit);
  const breakpoints = resolveEstimateBreakpoints(options?.breakpoints);

  const eligible = sortTicketsNewestFirst(
    tickets.filter((t) => t.stage === doneStage && hasComparableTokens(t)),
  );
  const window = eligible.slice(0, limit);
  const specs = segmentSpecs(breakpoints);
  const buckets: InsightsTicketInput[][] = specs.map(() => []);
  for (const ticket of window) {
    const index = bucketIndex(ticket.tokens_actual as number, breakpoints);
    buckets[index]!.push(ticket);
  }

  return {
    done_stage: doneStage,
    limit,
    breakpoints,
    window: {
      eligible_total: eligible.length,
      sample_size: window.length,
      newest_entered_at: window[0]?.stage_entered_at ?? null,
      oldest_entered_at:
        window.length === 0
          ? null
          : (window[window.length - 1]?.stage_entered_at ?? null),
    },
    overall: accuracyExtended(window),
    segments: specs.map((spec, index) => ({
      ...spec,
      ...accuracyExtended(buckets[index]!),
    })),
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
