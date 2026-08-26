import {
  claimedAgentKind,
  cloudWakeupPrompt,
  normalizeClaimedAgentId,
} from "./claimed-agent.js";
import type { Ticket } from "./types.js";

export const CURSOR_CLOUD_AGENTS_API = "https://api.cursor.com/v1/agents";
export const AGENT_BUSY_RETRY_MS = 30_000;

export type CursorFollowUpResult = {
  ok: boolean;
  status: number;
  busy: boolean;
  message?: string;
};

export type CursorCloudFollowUp = {
  followUp(agentId: string, prompt: string): Promise<CursorFollowUpResult>;
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

export async function nudgeClaimedCloudAgent(
  ticket: Ticket,
  verdict: string,
  client: CursorCloudFollowUp,
  options?: {
    sleep?: (ms: number) => Promise<void>;
    log?: (message: string) => void;
  },
): Promise<{ attempted: boolean; calls: number }> {
  const id = normalizeClaimedAgentId(ticket.fields.claimed_agent_id);
  if (claimedAgentKind(id) !== "cursor_cloud") {
    return { attempted: false, calls: 0 };
  }
  const prompt = cloudWakeupPrompt({
    ticketKey: ticket.fields.ticket_key,
    slug: ticket.slug,
    verdict,
    stage: ticket.fields.stage,
  });
  const sleep =
    options?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options?.log ?? ((message: string) => console.warn(message));

  const first = await client.followUp(id, prompt);
  if (first.ok) return { attempted: true, calls: 1 };
  if (!first.busy) {
    log(
      `[traceai] cursor cloud nudge failed for ${ticket.slug} (${id}): ${first.status} ${first.message ?? ""}`.trim(),
    );
    return { attempted: true, calls: 1 };
  }

  await sleep(AGENT_BUSY_RETRY_MS);
  const second = await client.followUp(id, prompt);
  if (!second.ok) {
    log(
      `[traceai] cursor cloud nudge skipped after busy retry for ${ticket.slug} (${id}): ${second.status} ${second.message ?? ""}`.trim(),
    );
  }
  return { attempted: true, calls: 2 };
}

/**
 * Fire-and-forget: never await from the review HTTP handler.
 * Default scheduler is `setImmediate` so the 30s busy-retry cannot block the UI.
 */
export function scheduleClaimedCloudNudges(
  tickets: readonly Ticket[],
  verdict: string,
  client: CursorCloudFollowUp | null | undefined,
  schedule: (fn: () => void) => void = (fn) => {
    setImmediate(fn);
  },
): void {
  if (!client) return;
  for (const ticket of tickets) {
    schedule(() => {
      void nudgeClaimedCloudAgent(ticket, verdict, client).catch((error) => {
        console.warn("[traceai] cursor cloud nudge threw", error);
      });
    });
  }
}
