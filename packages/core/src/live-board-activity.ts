/**
 * Product-owned live-board activity prompt (TRA-142).
 * Injected into MCP/API `summary` when the project toggle is on.
 * Never stored in workflow JSON.
 */

export const LIVE_BOARD_ACTIVITY_INSTRUCTION =
  "\nLIVE BOARD ACTIVITY (product; required): While you work a claimed ticket you MUST call set_ticket_activity on that ticket with a short human-readable line (max 80 characters) at every meaningful step. Refresh the line before the 120s TTL expires if you are still working. Clear with empty text when you wait on a human gate or stop. This is not a comment. Subagents may set it while the orchestrator holds the claim. Do not skip this because the tool looks optional.";

/** Only the stored string `true` is on. Missing / empty / anything else is off. */
export function isLiveBoardActivityEnabled(value: unknown): boolean {
  return typeof value === "string" && value.trim() === "true";
}

export function appendLiveBoardActivityInstruction(
  summary: string,
  enabled: boolean,
): string {
  if (!enabled) return summary;
  if (summary.includes("LIVE BOARD ACTIVITY (product; required):")) {
    return summary;
  }
  return `${summary}${LIVE_BOARD_ACTIVITY_INSTRUCTION}`;
}

/** Clone `agent_policy` only when the suffix is actually added. */
export function withLiveBoardActivityPolicy<T extends { summary: string }>(
  policy: T,
  enabled: boolean,
): T {
  const summary = appendLiveBoardActivityInstruction(policy.summary, enabled);
  if (summary === policy.summary) return policy;
  return { ...policy, summary };
}
