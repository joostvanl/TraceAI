import { slugify } from "./types.js";
import { ValidationError } from "./trace-errors.js";

/** Cap on getEntryBySlug probes when allocating a globally unique entry slug. */
export const UNIQUE_ENTRY_SLUG_MAX_ATTEMPTS = 50;

export type EntrySlugProber = {
  getEntryBySlug(
    apiId: string,
    slug: string,
    locale?: string,
  ): Promise<unknown | null>;
};

/**
 * Allocate a globally unique Aurora entry slug by probing `getEntryBySlug`
 * instead of scanning the full content-type list.
 *
 * Mirrors {@link uniqueSlug} suffixing: bare candidate, then `-2`, `-3`, …
 */
export async function allocateUniqueEntrySlug(
  client: EntrySlugProber,
  apiId: string,
  base: string,
  maxAttempts: number = UNIQUE_ENTRY_SLUG_MAX_ATTEMPTS,
): Promise<string> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new ValidationError("maxAttempts must be a positive integer");
  }
  const root = slugify(base);
  for (let n = 0; n < maxAttempts; n++) {
    const candidate = n === 0 ? root : `${root}-${n + 1}`;
    const existing = await client.getEntryBySlug(apiId, candidate);
    if (!existing) return candidate;
  }
  throw new ValidationError(
    `Could not allocate a unique ${apiId} slug from "${base}" after ${maxAttempts} attempts`,
  );
}
