import type { AuthStore } from "@traceai/auth";
import {
  claimedAgentKind,
  cloudCreateWakeupPrompt,
  firstStageKey,
  parseClaimedAgentId,
  scheduleClaimedCloudNudges,
  type CursorCloudFollowUp,
  type Ticket,
  type TraceService,
} from "@traceai/core";
import {
  cursorFollowUpForClaimer,
  resolveClaimerCursorApiKey,
} from "./agent-api-keys.js";
import {
  enqueueBusyCloudNudgeForVerdict,
  type NudgeQueueStore,
} from "./nudge-queue.js";

export const DEFAULT_AGENT_CREATE_VERDICT = "created";

export function defaultAgentCreatePrompt(ticket: Ticket): string {
  return cloudCreateWakeupPrompt({
    ticketKey: ticket.fields.ticket_key,
    slug: ticket.slug,
    stage: ticket.fields.stage,
  });
}

/**
 * After create: if the actor has a `bc-` default agent and a Cursor key, and
 * the ticket is on the workflow first stage, claim + fire-and-forget nudge.
 * Never throws — ticket create must stay 201.
 */
export async function claimAndNudgeDefaultAgentOnCreate(input: {
  ticket: Ticket;
  ownerUserId: string | null | undefined;
  authStore: AuthStore;
  service: Pick<TraceService, "getWorkflow" | "claimTicket">;
  cursorCloud?:
    | CursorCloudFollowUp
    | ((ticket: Ticket) => CursorCloudFollowUp | null)
    | null;
  cursorCloudFetch?: typeof fetch;
  scheduleWakeup?: (fn: () => void) => void;
  nudgeQueue?: NudgeQueueStore | null;
  now?: () => Date;
  log?: (message: string) => void;
}): Promise<Ticket> {
  const log = input.log ?? ((message: string) => console.warn(message));
  const ownerUserId = input.ownerUserId?.trim() || "";
  if (!ownerUserId) return input.ticket;

  try {
    const rawId = input.authStore.getDefaultCursorAgentId(ownerUserId);
    const parsed = parseClaimedAgentId(rawId);
    if (!parsed.ok || !parsed.value) return input.ticket;
    if (claimedAgentKind(parsed.value) !== "cursor_cloud") return input.ticket;

    const workflowSlug = input.ticket.fields.workflow?.trim();
    if (!workflowSlug) return input.ticket;
    const wf = await input.service.getWorkflow(workflowSlug);
    const first = wf ? firstStageKey(wf.stages) : null;
    if (!first || input.ticket.fields.stage !== first) return input.ticket;

    const key = resolveClaimerCursorApiKey(
      input.authStore,
      {
        fields: {
          ...input.ticket.fields,
          claimed_by_user_id: ownerUserId,
        },
      } as Pick<Ticket, "fields">,
    );
    if (!key.ok) return input.ticket;

    const claimed = await input.service.claimTicket(
      input.ticket.slug,
      parsed.value,
      ownerUserId,
    );
    // Aurora may persist claimed_agent_id but drop claimed_by_user_id (TRA-123).
    // Overlay the owner so cursorFollowUpForClaimer still decrypts the key.
    const claimedForNudge: Ticket = {
      ...claimed,
      fields: {
        ...claimed.fields,
        claimed_by_user_id:
          claimed.fields.claimed_by_user_id?.trim() || ownerUserId,
      },
    };

    const liveCursorCloud =
      input.cursorCloud !== undefined
        ? input.cursorCloud
        : (ticket: Ticket) =>
            cursorFollowUpForClaimer(input.authStore, ticket, {
              fetchImpl: input.cursorCloudFetch,
              fallbackUserId: ownerUserId,
            });

    scheduleClaimedCloudNudges(
      [claimedForNudge],
      DEFAULT_AGENT_CREATE_VERDICT,
      liveCursorCloud,
      input.scheduleWakeup,
      (ticket, nudgeResult) => {
        if (!input.nudgeQueue) return;
        try {
          enqueueBusyCloudNudgeForVerdict(
            input.nudgeQueue,
            ticket,
            DEFAULT_AGENT_CREATE_VERDICT,
            nudgeResult,
            input.now?.() ?? new Date(),
            ownerUserId,
          );
        } catch (error) {
          log(
            `[traceai] default-agent create nudge enqueue failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      },
      { prompt: defaultAgentCreatePrompt },
    );
    return claimed;
  } catch (error) {
    log(
      `[traceai] default-agent create nudge skipped for ${input.ticket.slug}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return input.ticket;
  }
}
