/**
 * Separator between project slug and logical wiki page slug in Aurora entry slugs.
 * Must be URL-safe (no consecutive hyphens — Aurora rejects `--`).
 */
export const WIKI_ENTRY_SLUG_SEP = "-wp-";

/** Legacy separator from TRA-66 first attempt; still recognized when resolving. */
const WIKI_ENTRY_SLUG_SEP_LEGACY = "--";

/**
 * Build a globally unique Aurora entry slug for a wiki page within a project.
 * Logical slugs (e.g. `home`) stay readable in URLs; entry slugs avoid collisions.
 */
export function wikiEntrySlug(project: string, logicalSlug: string): string {
  const projectSlug = project.trim();
  const logical = logicalSlug.trim();
  if (!projectSlug || !logical) {
    throw new Error("project and logicalSlug are required");
  }
  const prefix = `${projectSlug}${WIKI_ENTRY_SLUG_SEP}`;
  if (logical.startsWith(prefix)) return logical;
  const legacyPrefix = `${projectSlug}${WIKI_ENTRY_SLUG_SEP_LEGACY}`;
  if (logical.startsWith(legacyPrefix)) return logical;
  if (
    logical.includes(WIKI_ENTRY_SLUG_SEP) ||
    logical.includes(WIKI_ENTRY_SLUG_SEP_LEGACY)
  ) {
    // Already an entry-style slug — keep as-is.
    return logical;
  }
  return `${prefix}${logical}`;
}

/**
 * Derive the logical (URL) slug from an Aurora entry slug within a project.
 * Legacy bare slugs (e.g. TraceAI `home`) pass through unchanged.
 */
export function wikiLogicalSlug(entrySlug: string, project: string): string {
  const slug = entrySlug.trim();
  const projectSlug = project.trim();
  if (!slug) return slug;
  const prefix = `${projectSlug}${WIKI_ENTRY_SLUG_SEP}`;
  if (slug.startsWith(prefix)) return slug.slice(prefix.length);
  const legacyPrefix = `${projectSlug}${WIKI_ENTRY_SLUG_SEP_LEGACY}`;
  if (slug.startsWith(legacyPrefix)) return slug.slice(legacyPrefix.length);
  return slug;
}

/**
 * Find an entry slug in a project by exact entry slug or logical slug.
 */
export function resolveWikiEntrySlugInProject(input: {
  project: string;
  slugOrLogical: string;
  pages: Array<{ slug: string }>;
}): string | null {
  const want = input.slugOrLogical.trim();
  if (!want) return null;
  const exact = input.pages.find((p) => p.slug === want);
  if (exact) return exact.slug;
  const byLogical = input.pages.find(
    (p) => wikiLogicalSlug(p.slug, input.project) === want,
  );
  return byLogical?.slug ?? null;
}
