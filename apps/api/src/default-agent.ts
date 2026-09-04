import { DEFAULT_AGENT_SCOPES, type AuthStore } from "@traceai/auth";
import {
  claimedAgentKind,
  cloudCreateWakeupPrompt,
  cloudPerTicketCreatePrompt,
  CursorCloudAgentClient,
  firstStageKey,
  parseClaimedAgentId,
  scheduleClaimedCloudNudges,
  type CursorCloudFollowUp,
  type Ticket,
  type TraceService,
} from "@traceai/core";
import { resolveUserCursorApiKey } from "./agent-api-keys.js";
import { resolvePublicApiUrl } from "./mcp.js";
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
 * Explicitly opted-in first-stage creates use a saved `bc-` project default,
 * or create one per-ticket Cloud agent when that default is empty. A usable
 * personal Cursor key is required before either path. Never throws.
 */
export async function claimAndNudgeDefaultAgentOnCreate(input: {
  assignCloudAgent?: boolean;
  ticket: Ticket;
  ownerUserId: string | null | undefined;
  authStore: AuthStore;
  service: Pick<
    TraceService,
    "getWorkflow" | "claimTicket" | "getProjectDefaultAgent"
  > &
    Partial<Pick<TraceService, "upsertProjectAgent">>;
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
  if (input.assignCloudAgent !== true) return input.ticket;
  const project = input.ticket.fields.project?.trim() || "";
  if (!project) return input.ticket;

  try {
    const workflowSlug = input.ticket.fields.workflow?.trim();
    if (!workflowSlug) return input.ticket;
    const wf = await input.service.getWorkflow(workflowSlug);
    const first = wf ? firstStageKey(wf.stages) : null;
    if (!first || input.ticket.fields.stage !== first) return input.ticket;

    const ownerUserId = input.ownerUserId?.trim() || "";
    if (!ownerUserId) {
      log(
        `[traceai] default-agent create skipped for ${input.ticket.slug}: no_owner`,
      );
      return input.ticket;
    }
    const key = resolveUserCursorApiKey(input.authStore, ownerUserId);
    if (!key.ok) {
      log(
        `[traceai] default-agent create skipped for ${input.ticket.slug}: ${key.reason}`,
      );
      return input.ticket;
    }

    const rawId = await input.service.getProjectDefaultAgent(project);
    const parsed = parseClaimedAgentId(rawId);
    if (!parsed.ok) {
      log(
        `[traceai] default-agent create skipped for ${input.ticket.slug}: invalid_project_default`,
      );
      return input.ticket;
    }
    if (parsed.value && claimedAgentKind(parsed.value) !== "cursor_cloud") {
      log(
        `[traceai] default-agent create skipped for ${input.ticket.slug}: non_cloud_project_default`,
      );
      return input.ticket;
    }

    if (!parsed.value) {
      let mcpServers:
        | Array<{
            name: string;
            type: "http";
            url: string;
            headers: { Authorization: string };
          }>
        | undefined;
      try {
        const token = input.authStore.createToken({
          userId: ownerUserId,
          name: `cloud-${input.ticket.fields.ticket_key?.trim() || input.ticket.slug}`,
          scopes: [...DEFAULT_AGENT_SCOPES],
        });
        mcpServers = [
          {
            name: "traceai",
            type: "http",
            url: `${resolvePublicApiUrl()}/mcp`,
            headers: { Authorization: `Bearer ${token.token}` },
          },
        ];
      } catch {
        log(
          `[traceai] default-agent create for ${input.ticket.slug}: mcp_skipped`,
        );
      }
      const cursor = new CursorCloudAgentClient(
        key.apiKey,
        input.cursorCloudFetch,
      );
      const created = await cursor.create({
        prompt: cloudPerTicketCreatePrompt({
          ticketKey: input.ticket.fields.ticket_key,
          slug: input.ticket.slug,
          stage: input.ticket.fields.stage,
        }),
        name: (
          input.ticket.fields.ticket_key?.trim() || input.ticket.slug
        ).slice(0, 100),
        repos: [
          {
            url:
              process.env.TRACEAI_CURSOR_REPO_URL?.trim() ||
              "https://github.com/joostvanl/TraceAI",
            startingRef:
              process.env.TRACEAI_CURSOR_STARTING_REF?.trim() || "main",
          },
        ],
        ...(mcpServers ? { mcpServers } : {}),
        autoCreatePR: false,
      });
      if (
        !created.ok ||
        claimedAgentKind(created.agentId) !== "cursor_cloud"
      ) {
        log(
          `[traceai] default-agent create skipped for ${input.ticket.slug}: cursor_create_failed`,
        );
        return input.ticket;
      }
      const claimed = await input.service.claimTicket(
        input.ticket.slug,
        created.agentId,
        ownerUserId,
      );
      if (input.service.upsertProjectAgent) {
        try {
          await input.service.upsertProjectAgent({
            project,
            cursor_agent_id: created.agentId,
            display_name:
              input.ticket.fields.ticket_key?.trim() || input.ticket.slug,
          });
        } catch {
          log(
            `[traceai] default-agent display name skipped for ${input.ticket.slug}`,
          );
        }
      }
      return claimed;
    }

    const claimed = await input.service.claimTicket(
      input.ticket.slug,
      parsed.value,
      ownerUserId,
    );
    // Aurora may persist claimed_agent_id but drop claimed_by_user_id (TRA-123).
    // Overlay the owner because Aurora may omit it from the claim response.
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
        : new CursorCloudAgentClient(key.apiKey, input.cursorCloudFetch);

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
            ownerUserId || null,
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
