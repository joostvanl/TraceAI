import { isTicketReviewState, type Ticket, type WorkflowStage } from "./types.js";

export type ReviewInboxAwaiting = "verdict" | "agent";

export type ReviewInboxItem = {
  ticket: Ticket;
  project: string;
  stage_key: string;
  stage_name: string;
  awaiting: ReviewInboxAwaiting;
};

/**
 * Tickets in human-gated stages for the given project ticket list + stages.
 * - awaiting "verdict": no review_state yet (human must act)
 * - awaiting "agent": verdict recorded, stage still gated (agent must transition)
 */
export function buildReviewInboxItems(
  tickets: Ticket[],
  stages: WorkflowStage[],
  projectSlug: string,
): ReviewInboxItem[] {
  const stageByKey = new Map(stages.map((s) => [s.key, s] as const));
  const items: ReviewInboxItem[] = [];
  for (const ticket of tickets) {
    if (ticket.fields.project !== projectSlug) continue;
    const stage = stageByKey.get(ticket.fields.stage);
    if (!stage?.agent?.require_human_approval_on_exit) continue;
    const hasVerdict = isTicketReviewState(ticket.fields.review_state);
    items.push({
      ticket,
      project: projectSlug,
      stage_key: stage.key,
      stage_name: stage.name,
      awaiting: hasVerdict ? "agent" : "verdict",
    });
  }
  return items.sort((a, b) => {
    const aAt = a.ticket.fields.stage_entered_at ?? "";
    const bAt = b.ticket.fields.stage_entered_at ?? "";
    return bAt.localeCompare(aAt);
  });
}
