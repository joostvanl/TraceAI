import type { ListEntriesQuery } from "./aurora.js";

export type EntriesPage<T> = { items: T[]; total: number };

/**
 * Structural client shape accepted by {@link listAllEntries}.
 * Both `AuroraManagementClient` and `AuroraPublicClient` satisfy this.
 */
export type EntriesReader = {
  listEntries<T>(
    apiId: string,
    query?: ListEntriesQuery,
  ): Promise<EntriesPage<T>>;
};

/**
 * Page through all entries of a content type. Aurora caps `limit` at 100, so
 * anything that can exceed that must paginate instead of asking for more.
 * Prefer `field` + `in` for parent/child selections (max 50 values per page
 * request — callers must chunk larger IN-lists).
 */
export async function listAllEntries<T>(
  client: EntriesReader,
  apiId: string,
  query: Pick<ListEntriesQuery, "status" | "field" | "in" | "sort" | "order"> = {},
): Promise<T[]> {
  const pageSize = 100;
  const items: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const result = await client.listEntries<T>(apiId, {
      ...query,
      limit: pageSize,
      offset,
    });
    items.push(...result.items);
    if (result.items.length < pageSize || items.length >= result.total) break;
  }
  return items;
}
