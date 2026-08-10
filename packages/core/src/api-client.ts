export type TraceApiClientOptions = {
  apiUrl: string;
  token: string;
  /** When set, human-gate calls send X-TraceAI-Human-Proxy (web session only). */
  humanProxySecret?: string;
  /** Signed human identity header value (web session proxy). */
  humanIdentityHeader?: string;
};

export class TraceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "TraceApiError";
  }
}

export class TraceApiClient {
  readonly apiUrl: string;
  private readonly token: string;
  private readonly humanProxySecret?: string;
  private readonly humanIdentityHeader?: string;

  constructor(options: TraceApiClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "");
    this.token = options.token;
    this.humanProxySecret = options.humanProxySecret?.trim() || undefined;
    this.humanIdentityHeader = options.humanIdentityHeader?.trim() || undefined;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    options?: { asHuman?: boolean },
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (options?.asHuman && this.humanProxySecret) {
      headers.set("X-TraceAI-Human-Proxy", this.humanProxySecret);
      if (this.humanIdentityHeader) {
        headers.set("X-TraceAI-Human-Identity", this.humanIdentityHeader);
      }
    }

    const res = await fetch(`${this.apiUrl}${path}`, { ...init, headers });
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!res.ok) {
      const message =
        typeof body === "object" &&
        body &&
        "message" in body &&
        typeof (body as { message: unknown }).message === "string"
          ? (body as { message: string }).message
          : `TraceAI API ${res.status}`;
      const code =
        typeof body === "object" &&
        body &&
        "code" in body &&
        typeof (body as { code: unknown }).code === "string"
          ? (body as { code: string }).code
          : undefined;
      throw new TraceApiError(message, res.status, code, body);
    }

    return body as T;
  }

  listProjects() {
    return this.request<unknown[]>("/v1/projects");
  }

  getProject(slug: string) {
    return this.request<unknown>(`/v1/projects/${encodeURIComponent(slug)}`);
  }

  createProject(body: {
    name: string;
    description?: string;
    slug?: string;
    seed_workflow?: boolean;
  }) {
    return this.request<unknown>("/v1/projects", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  listTickets(
    project: string,
    stage?: string,
    parent?: string | null,
  ) {
    const params = new URLSearchParams({ project });
    if (stage) params.set("stage", stage);
    if (parent !== undefined) {
      params.set("parent", parent === null ? "" : parent);
    }
    return this.request<unknown[]>(`/v1/tickets?${params}`);
  }

  searchProject(
    project: string,
    query: Record<string, string | number | undefined> = {},
  ) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value == null || value === "") continue;
      params.set(key, String(value));
    }
    const q = params.toString();
    return this.request<unknown>(
      `/v1/projects/${encodeURIComponent(project)}/search${q ? `?${q}` : ""}`,
    );
  }

  listProjectHistory(
    project: string,
    query: {
      stage?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const params = new URLSearchParams();
    if (query.stage) params.set("stage", query.stage);
    if (query.limit != null) params.set("limit", String(query.limit));
    if (query.offset != null) params.set("offset", String(query.offset));
    const q = params.toString();
    return this.request<unknown>(
      `/v1/projects/${encodeURIComponent(project)}/history${q ? `?${q}` : ""}`,
    );
  }

  getProjectInsights(project: string) {
    return this.request<unknown>(
      `/v1/projects/${encodeURIComponent(project)}/insights`,
    );
  }

  getTicket(slug: string) {
    return this.request<unknown>(`/v1/tickets/${encodeURIComponent(slug)}`);
  }

  createTicket(body: Record<string, unknown>) {
    return this.request<unknown>(
      "/v1/tickets",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      { asHuman: Boolean(this.humanIdentityHeader) },
    );
  }

  updateTicket(slug: string, body: Record<string, unknown>) {
    return this.request<unknown>(
      `/v1/tickets/${encodeURIComponent(slug)}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
      { asHuman: Boolean(this.humanIdentityHeader) },
    );
  }

  transitionTicket(
    slug: string,
    toStage: string,
    comment?: string,
    tokens?: {
      tokens_estimate?: number;
      tokens_used?: number;
      resolution?: string;
      asHuman?: boolean;
    },
  ) {
    return this.request<unknown>(
      `/v1/tickets/${encodeURIComponent(slug)}/transition`,
      {
        method: "POST",
        body: JSON.stringify({
          to_stage: toStage,
          comment,
          tokens_estimate: tokens?.tokens_estimate,
          tokens_used: tokens?.tokens_used,
          resolution: tokens?.resolution,
        }),
      },
      { asHuman: tokens?.asHuman === true },
    );
  }

  /** Record a human review verdict; requires the human-proxy secret. */
  recordReviewVerdict(
    slug: string,
    body: {
      verdict: "approved" | "rejected";
      comment?: string;
      /** Signed-in reviewer, recorded instead of the proxy token name. */
      reviewer?: string;
      /** Also write the same verdict to gated descendants. */
      apply_to_children?: boolean;
    },
  ) {
    return this.request<unknown>(
      `/v1/tickets/${encodeURIComponent(slug)}/review`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      { asHuman: true },
    );
  }

  addComment(body: { ticket: string; body: string }) {
    return this.request<unknown>("/v1/comments", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  listWorkflows(project?: string) {
    const params = new URLSearchParams();
    if (project) params.set("project", project);
    const q = params.toString();
    return this.request<unknown[]>(`/v1/workflows${q ? `?${q}` : ""}`);
  }

  getWorkflow(slug: string) {
    return this.request<unknown>(`/v1/workflows/${encodeURIComponent(slug)}`);
  }

  createWorkflow(body: Record<string, unknown>) {
    return this.request<unknown>("/v1/workflows", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  updateWorkflow(slug: string, body: Record<string, unknown>) {
    return this.request<unknown>(`/v1/workflows/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  listWikiPages(project: string) {
    const params = new URLSearchParams({ project });
    return this.request<unknown[]>(`/v1/wiki-pages?${params}`);
  }

  getWikiPage(slug: string) {
    return this.request<unknown>(`/v1/wiki-pages/${encodeURIComponent(slug)}`);
  }

  createWikiPage(body: Record<string, unknown>) {
    return this.request<unknown>("/v1/wiki-pages", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  updateWikiPage(slug: string, body: Record<string, unknown>) {
    return this.request<unknown>(
      `/v1/wiki-pages/${encodeURIComponent(slug)}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
    );
  }

  me() {
    return this.request<unknown>("/v1/me");
  }

  uiLoginStatus() {
    return this.request<{ configured: boolean; mode?: "personal" | "legacy" | "none" }>(
      "/v1/ui/login/status",
    );
  }

  verifyUiLogin(body: { username: string; password: string }) {
    return this.request<{
      ok: true;
      user: string;
      identity: {
        user: string;
        slug: string | null;
        display_name: string;
        is_platform_admin: boolean;
        mode: "personal" | "legacy";
      };
    }>("/v1/ui/login/verify", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  listTraceaiUsers() {
    return this.request<unknown[]>(
      "/v1/traceai-users",
      {},
      { asHuman: Boolean(this.humanIdentityHeader) },
    );
  }

  createTraceaiUser(body: {
    username: string;
    password: string;
    display_name: string;
    email?: string;
    is_platform_admin?: boolean;
  }) {
    return this.request<unknown>(
      "/v1/traceai-users",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      { asHuman: Boolean(this.humanIdentityHeader) },
    );
  }

  updateTraceaiUser(
    slug: string,
    body: {
      display_name?: string;
      email?: string | null;
      status?: string;
      is_platform_admin?: boolean;
      password?: string;
    },
  ) {
    return this.request<unknown>(
      `/v1/traceai-users/${encodeURIComponent(slug)}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
      { asHuman: Boolean(this.humanIdentityHeader) },
    );
  }

  listProjectMembers(project: string) {
    return this.request<unknown[]>(
      `/v1/projects/${encodeURIComponent(project)}/members`,
      {},
      { asHuman: Boolean(this.humanIdentityHeader) },
    );
  }

  setProjectMember(
    project: string,
    body: { user: string; role: "admin" | "editor" | "viewer" },
  ) {
    return this.request<unknown>(
      `/v1/projects/${encodeURIComponent(project)}/members`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      { asHuman: Boolean(this.humanIdentityHeader) },
    );
  }

  removeProjectMember(project: string, user: string) {
    return this.request<{ ok: true }>(
      `/v1/projects/${encodeURIComponent(project)}/members/${encodeURIComponent(user)}`,
      { method: "DELETE" },
      { asHuman: Boolean(this.humanIdentityHeader) },
    );
  }
}
