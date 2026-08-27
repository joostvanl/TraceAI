import { normalizeClaimedAgentId } from "@traceai/core";

export type CopyClaimedAgentIdResult = "copied" | "empty" | "failed";

/**
 * Copy the raw claimed-agent id (TRA-125).
 * Clipboard failure is returned as `"failed"` so the UI can stay up.
 */
export async function copyClaimedAgentId(
  raw: string | null | undefined,
  writeText: (text: string) => Promise<void>,
): Promise<CopyClaimedAgentIdResult> {
  const id = normalizeClaimedAgentId(raw);
  if (!id) return "empty";
  try {
    await writeText(id);
    return "copied";
  } catch {
    return "failed";
  }
}
