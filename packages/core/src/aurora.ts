export type AuroraClientConfig = {
  apiUrl: string;
  token: string;
  locale?: string;
};

/**
 * Aurora list query. Field filter (`field` + `in`) selects entries whose named
 * content-type field equals one of the given values (max 50). See
 * https://aurora.joostvanleeuwaarden.com/docs/management-api
 */
export type ListEntriesQuery = {
  limit?: number;
  offset?: number;
  slug?: string;
  status?: string;
  locale?: string;
  sort?: string;
  order?: "asc" | "desc";
  /** Content-type field apiId to filter on (requires `in`). */
  field?: string;
  /** One value or IN-list (max 50) for `field`. */
  in?: string | readonly string[];
};

/** Aurora caps `in` to 50 values per request. */
export const AURORA_FIELD_IN_MAX = 50;

export function buildEntriesSearchParams(
  query: ListEntriesQuery,
  defaults: { locale: string; limit?: number },
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("limit", String(query.limit ?? defaults.limit ?? 100));
  if (query.offset != null) params.set("offset", String(query.offset));
  if (query.slug) params.set("slug", query.slug);
  if (query.status) params.set("status", query.status);
  if (query.sort) params.set("sort", query.sort);
  if (query.order) params.set("order", query.order);
  params.set("locale", query.locale ?? defaults.locale);

  const field = query.field?.trim();
  if (field) {
    const values = (Array.isArray(query.in) ? query.in : [query.in ?? ""])
      .map((v) => String(v).trim())
      .filter(Boolean);
    if (values.length === 0) {
      throw new Error(
        "Aurora listEntries field filter requires a non-empty `in` value list",
      );
    }
    if (values.length > AURORA_FIELD_IN_MAX) {
      throw new Error(
        `Aurora listEntries field filter allows at most ${AURORA_FIELD_IN_MAX} values in \`in\` (got ${values.length})`,
      );
    }
    params.set("field", field);
    params.set("in", values.join(","));
  }
  return params;
}

export class AuroraApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "AuroraApiError";
  }
}

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Aurora answers a rejected write with a bare "Validation failed" plus an
 * `issues` array; without those issues the message says nothing actionable.
 */
function errorMessage(body: unknown, fallback: string): string {
  if (typeof body !== "object" || !body) return fallback;
  const record = body as { message?: unknown; issues?: unknown };
  const message =
    typeof record.message === "string" && record.message
      ? record.message
      : fallback;
  if (!Array.isArray(record.issues) || record.issues.length === 0) {
    return message;
  }
  const issues = record.issues
    .map((issue) => {
      const { path, message: detail } = issue as {
        path?: unknown;
        message?: unknown;
      };
      const field = Array.isArray(path) ? path.join(".") : "";
      const text = typeof detail === "string" ? detail : JSON.stringify(issue);
      return field ? `${field}: ${text}` : text;
    })
    .join("; ");
  return `${message} (${issues})`;
}

export class AuroraManagementClient {
  readonly apiUrl: string;
  readonly locale: string;
  private _token: string;

  constructor(config: AuroraClientConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, "");
    this._token = config.token;
    this.locale = config.locale ?? "en-US";
  }

  get token(): string {
    return this._token;
  }

  setToken(token: string) {
    this._token = token;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this._token}`);
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const res = await fetch(`${this.apiUrl}${path}`, {
      ...init,
      headers,
    });
    const body = await parseJson(res);
    if (!res.ok) {
      throw new AuroraApiError(
        errorMessage(body, `Aurora API ${res.status}`),
        res.status,
        body,
      );
    }
    return body as T;
  }

  async selectWebsite(websiteId: string): Promise<{ token: string }> {
    const result = await this.request<{ token: string }>(
      "/api/v1/auth/select-website",
      {
        method: "POST",
        body: JSON.stringify({ websiteId }),
      },
    );
    this.setToken(result.token);
    return result;
  }

  listEntries<T>(apiId: string, query: ListEntriesQuery = {}) {
    const params = buildEntriesSearchParams(query, { locale: this.locale });
    return this.request<{
      items: T[];
      total: number;
      limit: number;
      offset: number;
    }>(`/api/v1/admin/content-types/${apiId}/entries?${params}`);
  }

  getEntryById<T>(apiId: string, entryId: string) {
    return this.request<T>(
      `/api/v1/admin/content-types/${apiId}/entries/by-id/${entryId}`,
    );
  }

  async getEntryBySlug<T>(apiId: string, slug: string, locale?: string) {
    const result = await this.listEntries<T>(apiId, {
      slug,
      locale,
      limit: 1,
    });
    return result.items[0] ?? null;
  }

  createEntry<T>(
    apiId: string,
    input: {
      slug: string;
      locale?: string;
      status?: "draft" | "published";
      fields?: Record<string, unknown>;
    },
  ) {
    return this.request<T>(`/api/v1/admin/content-types/${apiId}/entries`, {
      method: "POST",
      body: JSON.stringify({
        slug: input.slug,
        locale: input.locale ?? this.locale,
        status: input.status ?? "published",
        fields: input.fields ?? {},
      }),
    });
  }

  updateEntry<T>(
    apiId: string,
    entryId: string,
    input: {
      slug?: string;
      status?: "draft" | "published";
      fields?: Record<string, unknown>;
    },
  ) {
    return this.request<T>(
      `/api/v1/admin/content-types/${apiId}/entries/${entryId}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    );
  }

  publishEntry(apiId: string, entryId: string) {
    return this.request(
      `/api/v1/admin/content-types/${apiId}/entries/${entryId}/publish`,
      { method: "POST" },
    );
  }

  unpublishEntry(apiId: string, entryId: string) {
    return this.request(
      `/api/v1/admin/content-types/${apiId}/entries/${entryId}/unpublish`,
      { method: "POST" },
    );
  }

  listEntryVersions(apiId: string, entryId: string) {
    return this.request<
      Array<{
        id: string;
        entryId: string;
        label: string | null;
        source: string;
        snapshot: unknown;
        createdAt: string;
      }>
    >(`/api/v1/admin/content-types/${apiId}/entries/${entryId}/versions`);
  }

  createEntryVersion(
    apiId: string,
    entryId: string,
    input?: { label?: string },
  ) {
    return this.request<{
      id: string;
      entryId: string;
      label: string | null;
      source: string;
      snapshot: unknown;
      createdAt: string;
    }>(`/api/v1/admin/content-types/${apiId}/entries/${entryId}/versions`, {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    });
  }

  restoreEntryVersion(apiId: string, entryId: string, versionId: string) {
    return this.request<{
      entry: unknown;
      restoredFrom: {
        id: string;
        entryId: string;
        label: string | null;
        source: string;
        snapshot: unknown;
        createdAt: string;
      };
    }>(
      `/api/v1/admin/content-types/${apiId}/entries/${entryId}/versions/${versionId}/restore`,
      { method: "POST" },
    );
  }

  deleteEntry(apiId: string, entryId: string) {
    return this.request(
      `/api/v1/admin/content-types/${apiId}/entries/${entryId}`,
      { method: "DELETE" },
    );
  }

  /**
   * Check plaintext against a hashed `password` field on an entry.
   * Never returns the hash. Wrong password → AuroraApiError 401.
   */
  verifyEntryPassword(
    apiId: string,
    entryId: string,
    input: { password: string; fieldApiId?: string },
  ) {
    return this.request<{ ok: true; fieldApiId: string }>(
      `/api/v1/admin/content-types/${apiId}/entries/${entryId}/verify-password`,
      {
        method: "POST",
        body: JSON.stringify({
          password: input.password,
          fieldApiId: input.fieldApiId,
        }),
      },
    );
  }

  /**
   * Look up entry by slug and verify username + password fields.
   * Wrong username/password/unknown slug → AuroraApiError 401 (no distinction).
   */
  verifyCredentials(
    apiId: string,
    input: {
      slug: string;
      username: string;
      password: string;
      locale?: string;
      usernameFieldApiId?: string;
      passwordFieldApiId?: string;
    },
  ) {
    return this.request<{
      ok: true;
      entryId: string;
      slug?: string;
      username?: string;
    }>(`/api/v1/admin/content-types/${apiId}/verify-credentials`, {
      method: "POST",
      body: JSON.stringify({
        slug: input.slug,
        username: input.username,
        password: input.password,
        locale: input.locale ?? this.locale,
        usernameFieldApiId: input.usernameFieldApiId,
        passwordFieldApiId: input.passwordFieldApiId,
      }),
    });
  }
}

export class AuroraPublicClient {
  readonly apiUrl: string;
  readonly siteKey: string;
  readonly locale: string;

  constructor(config: { apiUrl: string; siteKey: string; locale?: string }) {
    this.apiUrl = config.apiUrl.replace(/\/$/, "");
    this.siteKey = config.siteKey;
    this.locale = config.locale ?? "en-US";
  }

  private async request<T>(path: string): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      headers: { "x-site-key": this.siteKey },
    });
    const body = await parseJson(res);
    if (!res.ok) {
      throw new AuroraApiError(
        errorMessage(body, `Aurora public API ${res.status}`),
        res.status,
        body,
      );
    }
    return body as T;
  }

  listEntries<T>(apiId: string, query: ListEntriesQuery = {}) {
    const params = buildEntriesSearchParams(query, { locale: this.locale });
    return this.request<{
      items: T[];
      total: number;
      limit: number;
      offset: number;
    }>(`/api/v1/content-types/${apiId}/entries?${params}`);
  }

  getEntry<T>(apiId: string, slug: string, locale?: string) {
    const params = new URLSearchParams();
    params.set("locale", locale ?? this.locale);
    return this.request<T>(
      `/api/v1/content-types/${apiId}/entries/${slug}?${params}`,
    );
  }
}
