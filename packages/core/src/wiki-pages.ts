import { WIKI_PAGE_LIST_MAX, type WikiPage } from "./types.js";

/** Tree order: sort_order first, then title. */
export function sortWikiPages(pages: WikiPage[]): WikiPage[] {
  return [...pages].sort((a, b) => {
    const so = (a.fields.sort_order ?? 0) - (b.fields.sort_order ?? 0);
    if (so !== 0) return so;
    return a.fields.title.localeCompare(b.fields.title);
  });
}

export type WikiPageSelection = {
  items: WikiPage[];
  total: number;
  limit: number;
  offset: number;
};

/**
 * Filter, order and slice a project's wiki pages.
 *
 * `total` is the count *before* slicing, so a caller can always tell a full
 * answer from a partial one — the whole point of the envelope. `parent`
 * undefined means "no filter"; null or "" selects root pages.
 *
 * Expects pages that are already scoped to one project.
 */
export function selectWikiPages(input: {
  pages: WikiPage[];
  parent?: string | null;
  limit?: number;
  offset?: number;
}): WikiPageSelection {
  let pages = sortWikiPages(input.pages);
  if (input.parent !== undefined) {
    const parent = input.parent === "" ? null : input.parent;
    pages = pages.filter((p) => (p.fields.parent ?? null) === parent);
  }

  const limit = Math.min(
    WIKI_PAGE_LIST_MAX,
    Math.max(1, Math.floor(input.limit ?? WIKI_PAGE_LIST_MAX) || WIKI_PAGE_LIST_MAX),
  );
  const offset = Math.max(0, Math.floor(input.offset ?? 0) || 0);
  return {
    items: pages.slice(offset, offset + limit),
    total: pages.length,
    limit,
    offset,
  };
}
