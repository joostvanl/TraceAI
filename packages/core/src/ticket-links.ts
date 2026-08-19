import { relationSlug, relationSlugOrEmpty } from "./relations.js";
import { NotFoundError, ValidationError } from "./trace-errors.js";
import { isTicketKeyPattern, type Ticket } from "./types.js";

export type TicketLinkRow = {
  slug: string;
  ticket_key?: string | null;
  project: string;
  parent?: string | null;
  tokens_estimate?: number | null;
  tokens_actual?: number | null;
};

export type TokenRollup = {
  tokens_estimate_rollup: number;
  tokens_actual_rollup: number;
};

function asLinkRow(ticket: Ticket | TicketLinkRow): TicketLinkRow {
  if ("fields" in ticket) {
    return {
      slug: ticket.slug,
      ticket_key: ticket.fields.ticket_key ?? null,
      project: relationSlugOrEmpty(ticket.fields.project),
      parent: relationSlug(ticket.fields.parent),
      tokens_estimate: ticket.fields.tokens_estimate ?? null,
      tokens_actual: ticket.fields.tokens_actual ?? null,
    };
  }
  return {
    ...ticket,
    project: relationSlugOrEmpty(ticket.project),
    parent: relationSlug(ticket.parent),
  };
}

/** Resolve a parent ref (slug or TRA-n) to a canonical slug within `rows`. */
export function resolveTicketRef(
  rows: Array<Ticket | TicketLinkRow>,
  ref: string,
): TicketLinkRow | null {
  const want = ref.trim();
  if (!want) return null;
  const normalized = rows.map(asLinkRow);
  const bySlug = normalized.find((t) => t.slug === want);
  if (bySlug) return bySlug;
  if (!isTicketKeyPattern(want)) return null;
  const key = want.toUpperCase();
  return (
    normalized.find((t) => (t.ticket_key ?? "").toUpperCase() === key) ?? null
  );
}

export function listChildTickets(
  rows: Array<Ticket | TicketLinkRow>,
  parentSlug: string,
): TicketLinkRow[] {
  return rows
    .map(asLinkRow)
    .filter((t) => (t.parent || null) === parentSlug)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** All descendants of `rootSlug` (not including the root), depth-first. */
export function listDescendantSlugs(
  rows: Array<Ticket | TicketLinkRow>,
  rootSlug: string,
): string[] {
  const normalized = rows.map(asLinkRow);
  const childrenOf = new Map<string, string[]>();
  for (const row of normalized) {
    const parent = row.parent || null;
    if (!parent) continue;
    const list = childrenOf.get(parent) ?? [];
    list.push(row.slug);
    childrenOf.set(parent, list);
  }
  const out: string[] = [];
  const stack = [...(childrenOf.get(rootSlug) ?? [])].reverse();
  const seen = new Set<string>();
  while (stack.length > 0) {
    const slug = stack.pop()!;
    if (seen.has(slug) || slug === rootSlug) continue;
    seen.add(slug);
    out.push(slug);
    const kids = childrenOf.get(slug) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push(kids[i]!);
    }
  }
  return out;
}

/**
 * Own estimate/actual (0 if missing) plus the same for every descendant.
 * Roll-up is derived — it never writes back to stored token fields.
 */
export function computeTokenRollup(
  rows: Array<Ticket | TicketLinkRow>,
  rootSlug: string,
): TokenRollup {
  const normalized = rows.map(asLinkRow);
  const bySlug = new Map(normalized.map((t) => [t.slug, t] as const));
  const root = bySlug.get(rootSlug);
  if (!root) {
    return { tokens_estimate_rollup: 0, tokens_actual_rollup: 0 };
  }

  const childrenOf = new Map<string, string[]>();
  for (const row of normalized) {
    const parent = row.parent || null;
    if (!parent) continue;
    const list = childrenOf.get(parent) ?? [];
    list.push(row.slug);
    childrenOf.set(parent, list);
  }

  let estimate = 0;
  let actual = 0;
  const stack = [rootSlug];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const slug = stack.pop()!;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const row = bySlug.get(slug);
    if (!row) continue;
    if (typeof row.tokens_estimate === "number") estimate += row.tokens_estimate;
    if (typeof row.tokens_actual === "number") actual += row.tokens_actual;
    for (const child of childrenOf.get(slug) ?? []) {
      stack.push(child);
    }
  }

  return {
    tokens_estimate_rollup: estimate,
    tokens_actual_rollup: actual,
  };
}

/**
 * Validate a parent assignment. Empty/null parent clears the link.
 * Returns the canonical parent slug to store, or null when cleared.
 */
export function validateTicketParent(input: {
  tickets: Array<Ticket | TicketLinkRow>;
  project: string;
  selfSlug?: string;
  parentRef?: string | null;
}): string | null {
  const raw = input.parentRef;
  if (raw == null || raw === "") return null;

  const parent = resolveTicketRef(input.tickets, raw);
  if (!parent) {
    throw new NotFoundError(`Parent ticket not found: ${raw}`);
  }
  if (parent.project !== input.project) {
    throw new ValidationError(
      `Parent ticket "${parent.slug}" belongs to a different project.`,
    );
  }
  if (input.selfSlug && parent.slug === input.selfSlug) {
    throw new ValidationError("A ticket cannot be its own parent.");
  }
  if (!input.selfSlug) return parent.slug;

  const bySlug = new Map(
    input.tickets.map(asLinkRow).map((t) => [t.slug, t] as const),
  );
  const seen = new Set<string>([input.selfSlug]);
  let cursor: string | null = parent.slug;
  while (cursor) {
    if (seen.has(cursor)) {
      throw new ValidationError(
        `Setting parent "${parent.slug}" would create a cycle in the ticket tree.`,
      );
    }
    seen.add(cursor);
    const ancestor = bySlug.get(cursor);
    const next = ancestor?.parent;
    cursor = typeof next === "string" && next.length > 0 ? next : null;
  }
  return parent.slug;
}
