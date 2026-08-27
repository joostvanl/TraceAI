import { ConflictError } from "./trace-errors.js";
import { normalizeClaimedAgentId } from "./claimed-agent.js";
import { slugify } from "./types.js";

/** Trimmed weergavenaam; empty / non-string → "". */
export function trimDisplayName(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Deterministic entry slug for a project_agent row. Aurora rejects `--`, so
 * the parts are joined with a single-dash keyword (same idea as memberships).
 */
export function projectAgentSlug(
  projectSlug: string,
  cursorAgentId: string,
): string {
  return `${projectSlug}-agent-${slugify(cursorAgentId)}`;
}

export type ProjectAgentNameRow = {
  cursor_agent_id: string;
  display_name: string;
};

/**
 * Case-insensitive uniqueness for a non-empty display_name inside one project.
 * Empty names skip the check. The row being written (same cursor_agent_id) is
 * excluded so an upsert can keep or recase its own name.
 */
export function assertUniqueProjectAgentDisplayName(input: {
  agents: readonly ProjectAgentNameRow[];
  cursorAgentId: string;
  displayName: string;
}): void {
  const name = trimDisplayName(input.displayName);
  if (!name) return;
  const id = normalizeClaimedAgentId(input.cursorAgentId);
  const want = name.toLowerCase();
  const clash = input.agents.find((row) => {
    const otherId = normalizeClaimedAgentId(row.cursor_agent_id);
    if (otherId && otherId === id) return false;
    return trimDisplayName(row.display_name).toLowerCase() === want;
  });
  if (clash) {
    throw new ConflictError(
      "display_name already used in this project",
      "AGENT_DISPLAY_NAME_CONFLICT",
    );
  }
}

/** Non-empty mapped name for a claimed id, else null (caller uses TRA-112). */
export function displayNameForCursorAgentId(
  agents: readonly ProjectAgentNameRow[],
  cursorAgentId: string | null | undefined,
): string | null {
  const id = normalizeClaimedAgentId(cursorAgentId);
  if (!id) return null;
  const match = agents.find(
    (row) => normalizeClaimedAgentId(row.cursor_agent_id) === id,
  );
  const name = trimDisplayName(match?.display_name);
  return name || null;
}

export function projectAgentNameMap(
  agents: readonly ProjectAgentNameRow[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of agents) {
    const id = normalizeClaimedAgentId(row.cursor_agent_id);
    const name = trimDisplayName(row.display_name);
    if (id && name) map.set(id, name);
  }
  return map;
}
