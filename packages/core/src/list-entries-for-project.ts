import { listAllEntries, type EntriesReader } from "./list-all-entries.js";

/**
 * Load project-scoped entries via `field`/`in`, with a full-scan fallback when
 * the relation is stored as an object (server filter matches nothing).
 * An empty scoped result is indistinguishable from "project has no entries".
 */
export async function listEntriesForProject<T>(
  client: EntriesReader,
  apiId: string,
  projectSlug: string,
  projectOf: (item: T) => string | null,
  query: { status?: string } = {},
): Promise<T[]> {
  const matches = (items: T[]) =>
    items.filter((item) => projectOf(item) === projectSlug);
  const scoped = matches(
    await listAllEntries<T>(client, apiId, {
      ...query,
      field: "project",
      in: [projectSlug],
    }),
  );
  if (scoped.length > 0) return scoped;
  return matches(await listAllEntries<T>(client, apiId, query));
}
