/**
 * Project-owned default Cursor Cloud agent (TRA-137).
 * One `bc-` id per project, stored on `project.default_cursor_agent_id`.
 * Membership `default_cursor_agent_id` is only read once: the first time the
 * project field is absent.
 */

export function uniqueMembershipBcDefault(
  rawValues: Array<string | null | undefined>,
): string | null {
  const distinct = new Set<string>();
  for (const raw of rawValues) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value.startsWith("bc-")) distinct.add(value);
  }
  if (distinct.size !== 1) return null;
  return [...distinct][0]!;
}

/**
 * Aurora omits a new optional text field until something writes it.
 * `undefined` / `null` = never written (first empty read may copy).
 * A present string — including `""` after clear — is the source of truth.
 */
export function projectDefaultFieldState(
  raw: string | null | undefined,
): { written: boolean; value: string | null } {
  if (raw === undefined || raw === null) {
    return { written: false, value: null };
  }
  const value = String(raw).trim();
  return { written: true, value: value || null };
}
