import { ticketBelongsOnBoard } from "@traceai/core";

export type BoardTicket = {
  slug: string;
  /** Immutable display key, e.g. TRA-42 */
  ticketKey?: string | null;
  title: string;
  stage: string;
  priority: string;
  /** When the ticket last entered its current stage (ISO). Used to sort last stage newest-first. */
  stageChangedAt?: string;
  tokensEstimate?: number | null;
  tokensActual?: number | null;
  /** Closure reason when set (typically on last stage). */
  resolution?: string | null;
  /** Human verdict on the current human-gated stage, if one was given. */
  reviewState?: string | null;
  /** Vertical order within a stage (first column). */
  sortOrder?: number | null;
  workflow?: string | null;
  /** Wees-pin on the default board — visible, not draggable. */
  orphan?: boolean;
  /** Claiming agent id when set; empty/null = unclaimed. Not live-updated via SSE in TRA-112. */
  claimedAgentId?: string | null;
};

export type BoardTicketEvent = {
  type: string;
  project: string;
  ticket: {
    slug: string;
    ticket_key?: string | null;
    title: string;
    stage: string;
    priority?: string;
    project: string;
    workflow?: string;
    tokens_estimate?: number | null;
    tokens_actual?: number | null;
    resolution?: string | null;
    review_state?: string | null;
    sort_order?: number | null;
  };
  at?: string;
};

export function applyBoardTicketEvent(
  prev: BoardTicket[],
  event: BoardTicketEvent,
  options: {
    projectSlug: string;
    selectedWorkflow: string;
    defaultWorkflow: string | null;
    projectWorkflowSlugs: string[];
  },
): BoardTicket[] {
  if (event.project && event.project !== options.projectSlug) return prev;
  if (!event.ticket?.slug) return prev;
  if (event.type === "ticket.commented") return prev;

  const without = prev.filter((t) => t.slug !== event.ticket.slug);
  const previous = prev.find((t) => t.slug === event.ticket.slug);
  const workflow = event.ticket.workflow ?? previous?.workflow ?? "";
  const belongs = ticketBelongsOnBoard({
    ticketWorkflow: workflow,
    selectedWorkflow: options.selectedWorkflow,
    defaultWorkflow: options.defaultWorkflow,
    projectWorkflowSlugs: options.projectWorkflowSlugs,
  });
  if (!belongs) return without;

  const next: BoardTicket = {
    slug: event.ticket.slug,
    ticketKey: event.ticket.ticket_key ?? previous?.ticketKey ?? null,
    title: event.ticket.title,
    stage: event.ticket.stage,
    priority: event.ticket.priority ?? "medium",
    stageChangedAt:
      event.type === "ticket.transitioned" || !previous
        ? (event.at ?? new Date().toISOString())
        : previous.stageChangedAt,
    tokensEstimate:
      event.ticket.tokens_estimate ?? previous?.tokensEstimate ?? null,
    tokensActual:
      event.ticket.tokens_actual ?? previous?.tokensActual ?? null,
    resolution: event.ticket.resolution ?? previous?.resolution ?? null,
    reviewState:
      event.type === "ticket.transitioned"
        ? null
        : (event.ticket.review_state ?? null),
    sortOrder:
      event.ticket.sort_order !== undefined
        ? event.ticket.sort_order
        : (previous?.sortOrder ?? null),
    workflow,
    orphan: workflow !== options.selectedWorkflow,
    claimedAgentId: previous?.claimedAgentId ?? null,
  };
  return [...without, next];
}
