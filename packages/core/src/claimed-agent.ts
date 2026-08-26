/** Derived from `claimed_agent_id`. Not stored on the ticket. */
export type ClaimedAgentKind = "cursor_cloud" | "other";

export const CLAIM_TICKET_BEFORE_HUMAN_GATE =
  "Before `transition_ticket` into a stage with `require_human_approval_on_exit`, call `claim_ticket` with this agent's id. Cursor Cloud: read `agent/id` from the metadata socket (`CURSOR_AGENT_SOCKET`, default `/run/cursor/api.sock`). Without a `bc-` claim there is no wake-up after the human verdict.";

export function normalizeClaimedAgentId(
  raw: string | null | undefined,
): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Non-empty ids must be a single token (no whitespace). Empty / null clears.
 * Prefix is not rejected: non-`bc-` claims are valid but never nudged.
 */
export function parseClaimedAgentId(
  raw: string | null | undefined,
): { ok: true; value: string } | { ok: false; message: string } {
  if (raw == null) return { ok: true, value: "" };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: "" };
  if (/\s/.test(trimmed)) {
    return {
      ok: false,
      message: "agent_id must be a single token without whitespace",
    };
  }
  return { ok: true, value: trimmed };
}

export function claimedAgentKind(
  raw: string | null | undefined,
): ClaimedAgentKind | null {
  const id = normalizeClaimedAgentId(raw);
  if (!id) return null;
  return id.startsWith("bc-") ? "cursor_cloud" : "other";
}

export function cloudWakeupPrompt(input: {
  ticketKey: string | null | undefined;
  slug: string;
  verdict: string;
  stage: string;
}): string {
  const key = input.ticketKey?.trim() || input.slug;
  return (
    `Human verdict recorded on ${key} (${input.slug}): ${input.verdict}. ` +
    `Current stage is still ${input.stage}. Call TraceAI get_ticket immediately, then ` +
    `transition_ticket with expected_stage=${input.stage} and expected_review_state=${input.verdict} ` +
    `according to the workflow playbook (approved → human_approve_to, rejected → a human_reject_to ` +
    `target with ## Reden, dismissed → human_dismiss_to). Do not wait for chat. Chat is not a verdict.`
  );
}
