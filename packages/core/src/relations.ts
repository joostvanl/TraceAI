/**
 * Aurora relation fields may be returned as a slug string (current behaviour)
 * or as a small object with `slug` / nested `entry.slug`. TraceAI API/MCP stay
 * slug-friendly — always coerce at read boundaries.
 */
export function relationSlug(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.slug === "string") {
    const trimmed = record.slug.trim();
    if (trimmed) return trimmed;
  }
  if (record.entry && typeof record.entry === "object") {
    const entry = record.entry as Record<string, unknown>;
    if (typeof entry.slug === "string") {
      const trimmed = entry.slug.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

/** Like relationSlug but never null — empty string when missing. */
export function relationSlugOrEmpty(value: unknown): string {
  return relationSlug(value) ?? "";
}
