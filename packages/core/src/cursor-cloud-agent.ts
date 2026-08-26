import {
  claimedAgentKind,
  cloudWakeupPrompt,
  normalizeClaimedAgentId,
} from "./claimed-agent.js";
import type { Ticket } from "./types.js";

export const CURSOR_CLOUD_AGENTS_API = "https://api.cursor.com/v1/agents";
export const AGENT_BUSY_RETRY_MS = 30_000;
export const AGENT_BUSY_RETRY_CAP_MS = 120_000;
export const AGENT_BUSY_RETRY_WINDOW_MS = 30 * 60 * 1000;

export type CursorFollowUpResult = {
  ok: boolean;
  status: number;
  busy: boolean;
  message?: string;
};

export type CursorCloudFollowUp = {
  followUp(agentId: string, prompt: string): Promise<CursorFollowUpResult>;
};

export type NudgeClaimResult = {
  attempted: boolean;
  calls: number;
  busy: boolean;
  status: number;
  agentId: string;
  prompt: string;
  message?: string;
};

function isBusyStatus(status: number, bodyText: string): boolean {
  if (status !== 409) return false;
  return /agent_busy/i.test(bodyText) || bodyText.length === 0 || status === 409;
}

export class CursorCloudAgentClient implements CursorCloudFollowUp {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = CURSOR_CLOUD_AGENTS_API,
  ) {}

  static fromEnv(
    env: NodeJS.Dict<string> = process.env,
    fetchImpl: typeof fetch = fetch,
  ): CursorCloudAgentClient | null {
    const key = env.CURSOR_API_KEY?.trim();
    if (!key) return null;
    return new CursorCloudAgentClient(key, fetchImpl);
  }

  async followUp(
    agentId: string,
    prompt: string,
  ): Promise<CursorFollowUpResult> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/${encodeURIComponent(agentId)}/runs`;
    const auth = Buffer.from(`${this.apiKey}:`, "utf8").toString("base64");
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: { text: prompt } }),
      });
      const text = await res.text().catch(() => "");
      if (res.ok) {
        return { ok: true, status: res.status, busy: false };
      }
      return {
        ok: false,
        status: res.status,
        busy: isBusyStatus(res.status, text),
        message: text.slice(0, 500),
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        busy: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/** Backoff after N busy attempts so far: 30s → 60s → cap 120s. */
export function agentBusyRetryDelayMs(attempts: number): number {
  const exp = Math.max(0, attempts - 1);
  return Math.min(AGENT_BUSY_RETRY_MS * 2 ** exp, AGENT_BUSY_RETRY_CAP_MS);
}

export function cloudNudgeSkipComment(input: {
  ticketKey?: string | null;
  slug: string;
  verdict: string;
  agentId: string;
  attempts: number;
  reason: string;
}): string {
  const key = input.ticketKey?.trim() || input.slug;
  return (
    `Cloud wake-up skipped for ${key} (${input.slug}): claimed agent ${input.agentId} ` +
    `did not accept POST /v1/agents/{id}/runs after ${input.attempts} attempt(s). ` +
    `Reason: ${input.reason}. Verdict ${input.verdict} and the claim are unchanged.`
  );
}

export function cloudNudgeSkipReason(input: {
  kind: "window_elapsed" | "non_busy_error" | "missing_key";
  status?: number;
}): string {
  if (input.kind === "window_elapsed") {
    return "agent_busy until the 30-minute retry window elapsed";
  }
  if (input.kind === "missing_key") {
    return "non-busy Cursor error missing CURSOR_API_KEY";
  }
  const status = input.status ?? 0;
  return `non-busy Cursor error ${status}`;
}

/**
 * One-shot follow-up for a `bc-` claim. Busy retries belong on the durable
 * queue (TRA-113), not in this call — never sleep here.
 */
export async function nudgeClaimedCloudAgent(
  ticket: Ticket,
  verdict: string,
  client: CursorCloudFollowUp,
  options?: {
    log?: (message: string) => void;
  },
): Promise<NudgeClaimResult> {
  const id = normalizeClaimedAgentId(ticket.fields.claimed_agent_id);
  if (claimedAgentKind(id) !== "cursor_cloud") {
    return {
      attempted: false,
      calls: 0,
      busy: false,
      status: 0,
      agentId: "",
      prompt: "",
    };
  }
  const prompt = cloudWakeupPrompt({
    ticketKey: ticket.fields.ticket_key,
    slug: ticket.slug,
    verdict,
    stage: ticket.fields.stage,
  });
  const log = options?.log ?? ((message: string) => console.warn(message));

  const first = await client.followUp(id, prompt);
  if (first.ok) {
    return {
      attempted: true,
      calls: 1,
      busy: false,
      status: first.status,
      agentId: id,
      prompt,
    };
  }
  if (!first.busy) {
    log(
      `[traceai] cursor cloud nudge failed for ${ticket.slug} (${id}): ${first.status} ${first.message ?? ""}`.trim(),
    );
    return {
      attempted: true,
      calls: 1,
      busy: false,
      status: first.status,
      agentId: id,
      prompt,
      message: first.message,
    };
  }

  return {
    attempted: true,
    calls: 1,
    busy: true,
    status: first.status,
    agentId: id,
    prompt,
    message: first.message,
  };
}

/**
 * Fire-and-forget: never await from the review HTTP handler.
 * Default scheduler is `setImmediate` so Cursor I/O cannot block the UI.
 * Busy results are reported via `onBusy` so the API can persist a queue row.
 */
export function scheduleClaimedCloudNudges(
  tickets: readonly Ticket[],
  verdict: string,
  client: CursorCloudFollowUp | null | undefined,
  schedule: (fn: () => void) => void = (fn) => {
    setImmediate(fn);
  },
  onBusy?: (ticket: Ticket, result: NudgeClaimResult) => void,
): void {
  if (!client) return;
  for (const ticket of tickets) {
    schedule(() => {
      void nudgeClaimedCloudAgent(ticket, verdict, client)
        .then((result) => {
          if (result.busy) onBusy?.(ticket, result);
        })
        .catch((error) => {
          console.warn("[traceai] cursor cloud nudge threw", error);
        });
    });
  }
}
