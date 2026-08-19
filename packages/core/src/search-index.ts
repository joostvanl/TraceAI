export type SearchHitType = "ticket" | "wiki_page";
export type SearchProfile = "focused" | "balanced" | "broad";

export type SearchTicketInput = {
  slug: string;
  ticket_key?: string | null;
  title: string;
  description?: string | null;
  stage: string;
  priority?: string | null;
  created_by?: string | null;
  resolution?: string | null;
  stage_entered_at?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  commentBodies?: string[];
  commentAuthors?: string[];
};

export type SearchWikiInput = {
  slug: string;
  title: string;
  body?: string | null;
  updatedAt?: string | null;
};

export type SearchFilters = {
  q?: string;
  type?: SearchHitType | "all";
  stage?: string;
  resolution?: string;
  priority?: string;
  created_by?: string;
  from?: string;
  to?: string;
};

export type SearchHit = {
  type: SearchHitType;
  slug: string;
  title: string;
  snippet: string;
  score: number;
  ticket_key?: string | null;
  stage?: string;
  priority?: string | null;
  resolution?: string | null;
  stage_entered_at?: string | null;
  created_by?: string | null;
};

export type SearchMeta = {
  algorithm: "bm25";
  profile: SearchProfile;
  query_tokens: string[];
  prefix_expansions_truncated: boolean;
  indexed_documents: number;
};

export type SearchOptions = {
  profile?: SearchProfile;
  includePreview?: boolean;
};

export type SearchResult = {
  hits: SearchHit[];
  meta: SearchMeta;
};

export type TimedProjectIndex<T> = {
  value: T;
  builtAt: number;
  lastAccessedAt: number;
};

export class ProjectIndexLruCache<T> {
  private readonly entries = new Map<string, TimedProjectIndex<T>>();

  constructor(
    private readonly ttlMs = 300_000,
    private readonly maxProjects = 2,
    private readonly now: () => number = Date.now,
  ) {}

  get(project: string): TimedProjectIndex<T> | undefined {
    const entry = this.entries.get(project);
    if (!entry) return undefined;
    if (this.now() - entry.builtAt > this.ttlMs) {
      this.entries.delete(project);
      return undefined;
    }
    entry.lastAccessedAt = this.now();
    this.entries.delete(project);
    this.entries.set(project, entry);
    return entry;
  }

  set(project: string, value: T): TimedProjectIndex<T> {
    const timestamp = this.now();
    const entry = { value, builtAt: timestamp, lastAccessedAt: timestamp };
    this.entries.delete(project);
    this.entries.set(project, entry);
    while (this.entries.size > Math.max(1, this.maxProjects)) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    return entry;
  }

  delete(project: string): void {
    this.entries.delete(project);
  }

  get size(): number {
    return this.entries.size;
  }

  projects(): string[] {
    return [...this.entries.keys()];
  }
}

type PreparedDocument = {
  type: SearchHitType;
  slug: string;
  title: string;
  snippetSource: string;
  tokens: string[];
  tf: Map<string, number>;
  length: number;
  ticket?: SearchTicketInput;
  wiki?: SearchWikiInput;
};

const STOPWORDS = new Set([
  "aan",
  "and",
  "bij",
  "dat",
  "de",
  "die",
  "dit",
  "een",
  "en",
  "for",
  "het",
  "hoe",
  "met",
  "naar",
  "of",
  "or",
  "the",
  "this",
  "van",
  "voor",
  "waar",
  "wat",
  "welke",
  "who",
  "with",
]);
const TOKEN_RE = /[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu;
const KEY_QUERY_RE = /^[a-z]{2,6}-\d+$/i;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const MAX_PREFIX_EXPANSIONS = 32;

export const SEARCH_PROFILE_DEFAULTS: Record<
  SearchProfile,
  { limit: number; snippetChars: number }
> = {
  focused: { limit: 8, snippetChars: 90 },
  balanced: { limit: 16, snippetChars: 140 },
  broad: { limit: 32, snippetChars: 190 },
};

function normalize(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").toLowerCase();
}

function usablePart(part: string): boolean {
  if (/^\d+$/.test(part)) return true;
  return part.length >= 3 && !STOPWORDS.has(part);
}

export function tokenizeForRetrieval(
  text: string,
  options: { keyQuery?: boolean } = {},
): string[] {
  const normalized = normalize(text).trim();
  if (!normalized) return [];
  if (options.keyQuery && KEY_QUERY_RE.test(normalized)) return [normalized];

  const tokens: string[] = [];
  for (const match of normalized.matchAll(TOKEN_RE)) {
    const raw = match[0]!;
    const parts = raw.split("-");
    if (parts.length > 1 && parts.every(usablePart)) tokens.push(raw);
    for (const part of parts) {
      if (usablePart(part)) tokens.push(part);
    }
  }
  return tokens;
}

function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  return tf;
}

function markdownHeadings(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, ""))
    .join("\n");
}

function prepareTicket(ticket: SearchTicketInput): PreparedDocument {
  const rankingSource = [
    ticket.ticket_key ?? "",
    ticket.title,
    ticket.title,
    ticket.description ?? "",
    ...(ticket.commentBodies ?? []),
  ].join("\n");
  const snippetSource = [
    ticket.title,
    ticket.description ?? "",
    ...(ticket.commentBodies ?? []),
  ].join("\n");
  const tokens = tokenizeForRetrieval(rankingSource);
  return {
    type: "ticket",
    slug: ticket.slug,
    title: ticket.title,
    snippetSource,
    tokens,
    tf: termFrequency(tokens),
    length: tokens.length,
    ticket,
  };
}

function prepareWiki(page: SearchWikiInput): PreparedDocument {
  const body = page.body ?? "";
  const rankingSource = [
    page.slug,
    page.title,
    page.title,
    markdownHeadings(body),
    body,
  ].join("\n");
  const snippetSource = [page.title, markdownHeadings(body), body].join("\n");
  const tokens = tokenizeForRetrieval(rankingSource);
  return {
    type: "wiki_page",
    slug: page.slug,
    title: page.title,
    snippetSource,
    tokens,
    tf: termFrequency(tokens),
    length: tokens.length,
    wiki: page,
  };
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function inDateRange(
  candidates: Array<string | null | undefined>,
  from?: string,
  to?: string,
): boolean {
  if (!from && !to) return true;
  const fromTime = from ? parseTime(from) : null;
  const toTime = to ? parseTime(to) : null;
  return candidates.some((candidate) => {
    const time = parseTime(candidate);
    if (time == null) return false;
    return (fromTime == null || time >= fromTime) && (toTime == null || time <= toTime);
  });
}

function matchesFilters(document: PreparedDocument, filters: SearchFilters): boolean {
  if (document.type === "wiki_page") {
    if (filters.stage || filters.resolution || filters.priority || filters.created_by) {
      return false;
    }
    return inDateRange([document.wiki?.updatedAt], filters.from, filters.to);
  }

  const ticket = document.ticket!;
  if (filters.stage && ticket.stage !== filters.stage) return false;
  if (filters.resolution && (ticket.resolution ?? "") !== filters.resolution) return false;
  if (filters.priority && (ticket.priority ?? "medium") !== filters.priority) return false;
  if (filters.created_by) {
    const wanted = normalize(filters.created_by);
    const authors = [ticket.created_by, ...(ticket.commentAuthors ?? [])].map(normalize);
    if (!authors.some((author) => author.includes(wanted))) return false;
  }
  return inDateRange(
    [ticket.stage_entered_at, ticket.createdAt, ticket.updatedAt],
    filters.from,
    filters.to,
  );
}

function snippetAround(text: string, token: string, maxLength: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const index = token ? normalize(cleaned).indexOf(token) : -1;
  if (index < 0) {
    return cleaned.length <= maxLength
      ? cleaned
      : `${cleaned.slice(0, maxLength - 1)}…`;
  }
  const half = Math.max(0, Math.floor((maxLength - token.length) / 2));
  const start = Math.max(0, index - half);
  const hasPrefix = start > 0;
  const initialEnd = Math.min(cleaned.length, start + maxLength);
  const hasSuffix = initialEnd < cleaned.length;
  const contentLength = Math.max(
    1,
    maxLength - Number(hasPrefix) - Number(hasSuffix),
  );
  const end = Math.min(cleaned.length, start + contentLength);
  return `${hasPrefix ? "…" : ""}${cleaned.slice(start, end)}${end < cleaned.length ? "…" : ""}`;
}

export class ProjectSearchIndex {
  private readonly documents = new Map<string, PreparedDocument>();
  private documentFrequency = new Map<string, number>();

  constructor(
    tickets: SearchTicketInput[] = [],
    wikiPages: SearchWikiInput[] = [],
  ) {
    for (const ticket of tickets) this.documents.set(`ticket:${ticket.slug}`, prepareTicket(ticket));
    for (const page of wikiPages) this.documents.set(`wiki_page:${page.slug}`, prepareWiki(page));
    this.rebuildDocumentFrequency();
  }

  get size(): number {
    return this.documents.size;
  }

  upsertTicket(ticket: SearchTicketInput): void {
    this.documents.set(`ticket:${ticket.slug}`, prepareTicket(ticket));
    this.rebuildDocumentFrequency();
  }

  upsertWikiPage(page: SearchWikiInput): void {
    this.documents.set(`wiki_page:${page.slug}`, prepareWiki(page));
    this.rebuildDocumentFrequency();
  }

  deleteWikiPage(slug: string): void {
    this.documents.delete(`wiki_page:${slug}`);
    this.rebuildDocumentFrequency();
  }

  search(filters: SearchFilters = {}, options: SearchOptions = {}): SearchResult {
    const profile = options.profile ?? "balanced";
    const query = normalize(filters.q).trim();
    const keyQuery = KEY_QUERY_RE.test(query);
    const queryTokens = tokenizeForRetrieval(query, { keyQuery });
    const type = filters.type ?? "all";
    const candidates = [...this.documents.values()].filter(
      (document) =>
        (type === "all" || document.type === type) && matchesFilters(document, filters),
    );

    if (query && queryTokens.length === 0) {
      return {
        hits: [],
        meta: {
          algorithm: "bm25",
          profile,
          query_tokens: [],
          prefix_expansions_truncated: false,
          indexed_documents: this.documents.size,
        },
      };
    }

    const expansions = new Map<string, string[]>();
    let truncated = false;
    for (const token of queryTokens) {
      const matching = [...this.documentFrequency.entries()]
        .filter(([candidate]) =>
          keyQuery || token.length < 3
            ? candidate === token
            : candidate === token || candidate.startsWith(token),
        )
        .sort(([tokenA, dfA], [tokenB, dfB]) => dfB - dfA || tokenA.localeCompare(tokenB));
      if (matching.length > MAX_PREFIX_EXPANSIONS) truncated = true;
      expansions.set(
        token,
        matching.slice(0, MAX_PREFIX_EXPANSIONS).map(([candidate]) => candidate),
      );
    }

    const avgLength =
      candidates.reduce((sum, document) => sum + document.length, 0) /
        Math.max(1, candidates.length) || 1;
    const hits: SearchHit[] = [];
    for (const document of candidates) {
      if (!query) {
        hits.push(this.toHit(document, 1, "", profile, options.includePreview !== false));
        continue;
      }

      let score = 0;
      const presentTokens: Array<{ token: string; idf: number }> = [];
      for (const expanded of expansions.values()) {
        for (const token of expanded) {
          const frequency = document.tf.get(token) ?? 0;
          if (!frequency) continue;
          const df = candidates.reduce(
            (count, candidate) => count + Number(candidate.tf.has(token)),
            0,
          );
          const idf = Math.log(
            1 + (candidates.length - df + 0.5) / (df + 0.5),
          );
          const denominator =
            frequency +
            BM25_K1 *
              (1 - BM25_B + BM25_B * (document.length / avgLength));
          score += idf * ((frequency * (BM25_K1 + 1)) / denominator);
          presentTokens.push({ token, idf });
        }
      }
      if (document.type === "ticket" && normalize(document.ticket?.ticket_key) === query) {
        score += 100;
      } else if (document.type === "wiki_page" && normalize(document.slug) === query) {
        score += 100;
      }
      if (score <= 0) continue;

      presentTokens.sort((a, b) => b.idf - a.idf || a.token.localeCompare(b.token));
      hits.push(
        this.toHit(
          document,
          score,
          presentTokens[0]?.token ?? "",
          profile,
          options.includePreview !== false,
        ),
      );
    }

    hits.sort(
      (a, b) =>
        b.score - a.score ||
        a.title.localeCompare(b.title) ||
        a.slug.localeCompare(b.slug),
    );
    return {
      hits,
      meta: {
        algorithm: "bm25",
        profile,
        query_tokens: queryTokens,
        prefix_expansions_truncated: truncated,
        indexed_documents: this.documents.size,
      },
    };
  }

  private toHit(
    document: PreparedDocument,
    score: number,
    anchor: string,
    profile: SearchProfile,
    includePreview: boolean,
  ): SearchHit {
    const snippet = includePreview
      ? snippetAround(
          document.snippetSource,
          anchor,
          SEARCH_PROFILE_DEFAULTS[profile].snippetChars,
        )
      : "";
    if (document.type === "wiki_page") {
      return {
        type: "wiki_page",
        slug: document.slug,
        title: document.title,
        snippet,
        score,
      };
    }
    const ticket = document.ticket!;
    return {
      type: "ticket",
      slug: document.slug,
      title: document.title,
      snippet,
      score,
      ticket_key: ticket.ticket_key ?? null,
      stage: ticket.stage,
      priority: ticket.priority ?? "medium",
      resolution: ticket.resolution ?? null,
      stage_entered_at: ticket.stage_entered_at ?? null,
      created_by: ticket.created_by ?? null,
    };
  }

  private rebuildDocumentFrequency(): void {
    const frequencies = new Map<string, number>();
    for (const document of this.documents.values()) {
      for (const token of new Set(document.tokens)) {
        frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      }
    }
    this.documentFrequency = frequencies;
  }
}

export function searchIndexedContent(input: {
  tickets: SearchTicketInput[];
  wikiPages?: SearchWikiInput[];
  filters?: SearchFilters;
  options?: SearchOptions;
}): SearchResult {
  return new ProjectSearchIndex(input.tickets, input.wikiPages).search(
    input.filters,
    input.options,
  );
}
