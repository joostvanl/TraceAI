import { Registry, Counter, Gauge, Histogram } from "prom-client";
import type { TicketEvent } from "./events.js";

/** Dedicated registry so tests and the API process do not share the default one. */
export const register = new Registry();

const ticketsCreated = new Counter({
  name: "traceai_tickets_created_total",
  help: "Tickets created",
  labelNames: ["project"] as const,
  registers: [register],
});

const ticketTransitions = new Counter({
  name: "traceai_ticket_transitions_total",
  help: "Ticket stage transitions",
  labelNames: ["project", "from_stage", "to_stage"] as const,
  registers: [register],
});

const ticketReviews = new Counter({
  name: "traceai_ticket_reviews_total",
  help: "Human review verdicts recorded",
  labelNames: ["project", "verdict"] as const,
  registers: [register],
});

const commentsCreated = new Counter({
  name: "traceai_comments_created_total",
  help: "Comments created",
  labelNames: ["project"] as const,
  registers: [register],
});

const wikiWrites = new Counter({
  name: "traceai_wiki_writes_total",
  help: "Wiki page creates and updates",
  labelNames: ["project", "op"] as const,
  registers: [register],
});

const tokensUsed = new Counter({
  name: "traceai_tokens_used_total",
  help: "LLM tokens reported on successful ticket transitions",
  labelNames: ["project"] as const,
  registers: [register],
});

const httpRequests = new Counter({
  name: "traceai_http_requests_total",
  help: "HTTP requests handled by the API",
  labelNames: ["method", "route", "status"] as const,
  registers: [register],
});

const httpDuration = new Histogram({
  name: "traceai_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"] as const,
  registers: [register],
});

const ticketsByStage = new Gauge({
  name: "traceai_tickets",
  help: "Current ticket count by project and stage",
  labelNames: ["project", "stage"] as const,
  registers: [register],
});

const ticketsWithReviewState = new Gauge({
  name: "traceai_tickets_with_review_state",
  help: "Current tickets that have a non-empty review_state",
  labelNames: ["project", "review_state"] as const,
  registers: [register],
});

const inboxReviewsOpen = new Gauge({
  name: "traceai_inbox_reviews_open",
  help: "Open human-review inbox items awaiting a verdict",
  registers: [register],
});

const up = new Gauge({
  name: "traceai_up",
  help: "1 while the API can answer /metrics",
  registers: [register],
});
up.set(1);

const sseSubscribers = new Gauge({
  name: "traceai_sse_subscribers",
  help: "In-process ticket event bus subscriber count",
  registers: [register],
});

const eventsLatestId = new Gauge({
  name: "traceai_events_latest_id",
  help: "Durable ticket-event store max id",
  registers: [register],
});

function label(value: string | null | undefined, fallback = "unknown"): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export function observeTicketEvent(event: TicketEvent): void {
  const project = label(event.project);
  switch (event.type) {
    case "ticket.created":
      ticketsCreated.inc({ project });
      return;
    case "ticket.transitioned":
      ticketTransitions.inc({
        project,
        from_stage: label(event.from_stage),
        to_stage: label(event.to_stage ?? event.ticket.stage),
      });
      return;
    case "ticket.reviewed":
      ticketReviews.inc({
        project,
        verdict: label(event.ticket.review_state),
      });
      return;
    case "ticket.commented":
      commentsCreated.inc({ project });
      return;
    default:
      return;
  }
}

export function observeWikiWrite(input: {
  project: string;
  op: "create" | "update";
}): void {
  wikiWrites.inc({ project: label(input.project), op: input.op });
}

export function observeTokensUsed(input: {
  project: string;
  tokens: number;
}): void {
  if (!Number.isFinite(input.tokens) || input.tokens < 0) return;
  tokensUsed.inc({ project: label(input.project) }, input.tokens);
}

export function observeHttp(input: {
  method: string;
  route: string;
  status: number;
  seconds: number;
}): void {
  const labels = {
    method: input.method.toUpperCase(),
    route: label(input.route, "unmatched"),
    status: String(input.status),
  };
  httpRequests.inc(labels);
  if (labels.route !== "/metrics") {
    httpDuration.observe(labels, input.seconds);
  }
}

export function snapshotBoard(input: {
  tickets: Array<{
    project: string;
    stage: string;
    review_state?: string | null;
  }>;
  inboxOpen: number;
}): void {
  ticketsByStage.reset();
  ticketsWithReviewState.reset();
  const stageCounts = new Map<string, number>();
  const reviewCounts = new Map<string, number>();
  for (const ticket of input.tickets) {
    const project = label(ticket.project);
    const stage = label(ticket.stage);
    const stageKey = `${project}\0${stage}`;
    stageCounts.set(stageKey, (stageCounts.get(stageKey) ?? 0) + 1);
    const reviewState = ticket.review_state?.trim();
    if (reviewState) {
      const reviewKey = `${project}\0${reviewState}`;
      reviewCounts.set(reviewKey, (reviewCounts.get(reviewKey) ?? 0) + 1);
    }
  }
  for (const [key, count] of stageCounts) {
    const [project, stage] = key.split("\0");
    ticketsByStage.set({ project, stage }, count);
  }
  for (const [key, count] of reviewCounts) {
    const [project, review_state] = key.split("\0");
    ticketsWithReviewState.set({ project, review_state }, count);
  }
  inboxReviewsOpen.set(input.inboxOpen);
}

export function setSupportGauges(input: {
  subscribers: number;
  latestId: number;
}): void {
  sseSubscribers.set(input.subscribers);
  eventsLatestId.set(input.latestId);
}

type SnapshotService = {
  listProjects: () => Promise<Array<{ slug: string }>>;
  listTickets: (input: { project: string }) => Promise<
    Array<{
      fields: { stage?: string; review_state?: string | null };
    }>
  >;
  listReviewInbox?: (
    slugs: string[],
  ) => Promise<Array<{ awaiting?: string }>>;
};

/** Best-effort board snapshot. Missing stubs or Aurora errors leave gauges unchanged. */
export async function snapshotFromService(service: SnapshotService): Promise<void> {
  const projects = await service.listProjects();
  const tickets: Array<{
    project: string;
    stage: string;
    review_state?: string | null;
  }> = [];
  for (const project of projects) {
    const rows = await service.listTickets({ project: project.slug });
    for (const row of rows) {
      tickets.push({
        project: project.slug,
        stage: row.fields.stage ?? "unknown",
        review_state: row.fields.review_state,
      });
    }
  }
  let inboxOpen = 0;
  if (typeof service.listReviewInbox === "function") {
    const items = await service.listReviewInbox(projects.map((p) => p.slug));
    inboxOpen = items.filter((item) => item.awaiting === "verdict").length;
  }
  snapshotBoard({ tickets, inboxOpen });
}

export async function renderMetrics(): Promise<string> {
  return register.metrics();
}

export function metricsContentType(): string {
  return register.contentType;
}
