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

export type CursorCreateInput = {
  prompt: string;
  name: string;
  repos: Array<{ url: string; startingRef: string }>;
  mcpServers?: Array<{
    name: string;
    type: "http";
    url: string;
    headers: { Authorization: string };
  }>;
  autoCreatePR: false;
};

export type CursorCreateResult =
  | { ok: true; status: number; agentId: string }
  | { ok: false; status: number; message: string };

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

  async create(input: CursorCreateInput): Promise<CursorCreateResult> {
    const url = this.baseUrl.replace(/\/$/, "");
    const auth = Buffer.from(`${this.apiKey}:`, "utf8").toString("base64");
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: { text: input.prompt },
          name: input.name.slice(0, 100),
          repos: input.repos,
          ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
          autoCreatePR: input.autoCreatePR,
        }),
      });
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          message: `Cursor create failed (${res.status})`,
        };
      }
      const body = (await res.json().catch(() => null)) as
        | { agent?: { id?: unknown } }
        | null;
      const agentId =
        typeof body?.agent?.id === "string" ? body.agent.id.trim() : "";
      if (!agentId) {
        return {
          ok: false,
          status: res.status,
          message: "Cursor create response missing agent id",
        };
      }
      return { ok: true, status: res.status, agentId };
    } catch (error) {
      const raw = error instanceof Error ? error.name : "unknown";
      return {
        ok: false,
        status: 0,
        message: `Cursor create request failed (${raw.slice(0, 80)})`,
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
    prompt?: string;
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
  const prompt =
    options?.prompt ??
    cloudWakeupPrompt({
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

export type CloudNudgeClientSource =
  | CursorCloudFollowUp
  | ((ticket: Ticket) => CursorCloudFollowUp | null);

/**
 * Fire-and-forget: never await from the review HTTP handler.
 * Default scheduler is `setImmediate` so Cursor I/O cannot block the UI.
 * Busy results are reported via `onBusy` so the API can persist a queue row.
 * Pass a per-ticket resolver so nudges use the claimer's Cursor key (TRA-114).
 */
export function scheduleClaimedCloudNudges(
  tickets: readonly Ticket[],
  verdict: string,
  client: CloudNudgeClientSource | null | undefined,
  schedule: (fn: () => void) => void = (fn) => {
    setImmediate(fn);
  },
  onBusy?: (ticket: Ticket, result: NudgeClaimResult) => void,
  options?: {
    prompt?: (ticket: Ticket) => string;
  },
): void {
  if (!client) return;
  for (const ticket of tickets) {
    schedule(() => {
      const resolved = typeof client === "function" ? client(ticket) : client;
      if (!resolved) return;
      void nudgeClaimedCloudAgent(ticket, verdict, resolved, {
        prompt: options?.prompt?.(ticket),
      })
        .then((result) => {
          if (result.busy) onBusy?.(ticket, result);
        })
        .catch((error) => {
          console.warn("[traceai] cursor cloud nudge threw", error);
        });
    });
  }
}
