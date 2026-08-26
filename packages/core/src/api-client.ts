import type { TicketReviewState } from "./types.js";

export type TraceApiClientOptions = {
  apiUrl: string;
  token: string;
  /** When set, human-gate calls send X-TraceAI-Human-Proxy (web session only). */
  humanProxySecret?: string;
  /** Signed human identity header value (web session proxy). */
  humanIdentityHeader?: string;
  /**
   * Optional fetch implementation. Hosted MCP uses this to route tool calls
   * in-process through the Hono app (no HTTP loopback).
   */
  fetchImpl?: typeof fetch;
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
  private readonly fetchImpl: typeof fetch;

  constructor(options: TraceApiClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "");
    this.token = options.token;
    this.humanProxySecret = options.humanProxySecret?.trim() || undefined;
    this.humanIdentityHeader = options.humanIdentityHeader?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
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

    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      ...init,
      headers,
    });
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

  // These three must forward the human identity whenever the client holds one.
  // Since TRA-81 the API answers them per principal: without the identity it
  // judges the web server's own token, which carries admin scope, so the caller
  // would see every project and a membership check would be meaningless.
  // `/v1/me/projects` outright requires it and returns 401 otherwise.
  listProjects() {
    return this.request<unknown[]>(
      "/v1/projects",
      {},
      { asHuman: Boolean(this.humanIdentityHeader) },
    );
  }

  listMyProjects() {
    return this.request<unknown[]>(
      "/v1/me/projects",
      {},
      { asHuman: Boolean(this.humanIdentityHeader) },
    );
  }

  getProject(slug: string) {
    return this.request<unknown>(
      `/v1/projects/${encodeURIComponent(slug)}`,
      {},
      { asHuman: Boolean(this.humanIdentityHeader) },
    );
  }

  createProject(body: {
    name: string;
    description?: string;
    slug?: string;
    seed_workflow?: boolean;
    seed_wiki?: boolean;
    owner_user?: string;
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
    workflow?: string,
  ) {
    const params = new URLSearchParams({ project });
    if (stage) params.set("stage", stage);
    if (parent !== undefined) {
      params.set("parent", parent === null ? "" : parent);
    }
    if (workflow) params.set("workflow", workflow);
    return this.request<unknown[]>(`/v1/tickets?${params}`);
  }

  searchProject(
    project: string,
    query: Record<string, string | number | boolean | undefined> = {},
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

  getEstimateVsActual(
    project: string,
    query: { limit?: number; breakpoints?: number[] } = {},
  ) {
    const params = new URLSearchParams();
    if (query.limit != null) params.set("limit", String(query.limit));
    if (query.breakpoints != null) {
      params.set("breakpoints", query.breakpoints.join(","));
    }
    const q = params.toString();
    return this.request<unknown>(
      `/v1/projects/${encodeURIComponent(project)}/estimate-vs-actual${
        q ? `?${q}` : ""
      }`,
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

  reorderTickets(body: {
    project: string;
    stage: string;
    workflow: string;
    ordered_slugs: string[];
  }) {
    return this.request<unknown>(
      "/v1/tickets/reorder",
      {
        method: "POST",
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
      expected_stage?: string;
      expected_review_state?: string | null;
      asHuman?: boolean;
    },
  ) {
    const payload: Record<string, unknown> = {
      to_stage: toStage,
      comment,
      tokens_estimate: tokens?.tokens_estimate,
      tokens_used: tokens?.tokens_used,
      resolution: tokens?.resolution,
    };
    if (tokens?.expected_stage !== undefined) {
      payload.expected_stage = tokens.expected_stage;
    }
    if (tokens && "expected_review_state" in tokens) {
      payload.expected_review_state = tokens.expected_review_state;
    }
    return this.request<unknown>(
      `/v1/tickets/${encodeURIComponent(slug)}/transition`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      { asHuman: tokens?.asHuman === true },
    );
  }

  /** Record a human review verdict; requires the human-proxy secret. */
  recordReviewVerdict(
    slug: string,
    body: {
      verdict: TicketReviewState;
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

  claimTicket(slug: string, agentId: string) {
    return this.request<unknown>(
      `/v1/tickets/${encodeURIComponent(slug)}/claim`,
      {
        method: "POST",
        body: JSON.stringify({ agent_id: agentId }),
      },
    );
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
    return this.request<unknown>(
      "/v1/workflows",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      { asHuman: Boolean(this.humanIdentityHeader) },
    );
  }

  patchProject(slug: string, body: { default_workflow: string }) {
    return this.request<unknown>(
      `/v1/projects/${encodeURIComponent(slug)}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
      { asHuman: Boolean(this.humanIdentityHeader) },
    );
  }

  cloneWorkflow(project: string, body: { source: string }) {
    return this.request<unknown>(
      `/v1/projects/${encodeURIComponent(project)}/workflows/clone`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      { asHuman: Boolean(this.humanIdentityHeader) },
    );
  }

  updateWorkflow(slug: string, body: Record<string, unknown>) {
    return this.request<unknown>(`/v1/workflows/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  saveWorkflowDraft(slug: string, body: Record<string, unknown>) {
    return this.request<unknown>(
      `/v1/workflows/${encodeURIComponent(slug)}/draft`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  }

  previewWorkflowActivation(slug: string) {
    return this.request<unknown>(
      `/v1/workflows/${encodeURIComponent(slug)}/activation-preview`,
    );
  }

  activateWorkflow(slug: string, body: Record<string, unknown> = {}) {
    return this.request<unknown>(
      `/v1/workflows/${encodeURIComponent(slug)}/activate`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  }

  listWorkflowVersions(slug: string) {
    return this.request<unknown[]>(
      `/v1/workflows/${encodeURIComponent(slug)}/versions`,
    );
  }

  restoreWorkflowVersion(slug: string, versionId: string) {
    return this.request<unknown>(
      `/v1/workflows/${encodeURIComponent(slug)}/versions/${encodeURIComponent(versionId)}/restore`,
      { method: "POST" },
    );
  }

  applyWorkflowTemplate(slug: string, body: Record<string, unknown>) {
    return this.request<unknown>(
      `/v1/workflows/${encodeURIComponent(slug)}/templates/apply`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  }

  listWikiPages(
    project: string,
    query: {
      include_body?: boolean;
      parent?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const params = new URLSearchParams({ project });
    if (query.include_body) params.set("include_body", "true");
    if (query.parent != null) params.set("parent", query.parent);
    if (query.limit != null) params.set("limit", String(query.limit));
    if (query.offset != null) params.set("offset", String(query.offset));
    return this.request<{
      items: unknown[];
      total: number;
      limit: number;
      offset: number;
    }>(`/v1/wiki-pages?${params}`);
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

  listReviewInbox() {
    return this.request<{
      awaiting_verdict: Array<Record<string, unknown>>;
      awaiting_agent: Array<Record<string, unknown>>;
    }>("/v1/inbox/reviews", {}, { asHuman: Boolean(this.humanIdentityHeader) });
  }

  listNotifications(options: { unreadOnly?: boolean } = {}) {
    const q = options.unreadOnly ? "?unread=1" : "";
    return this.request<{
      unread_count: number;
      items: Array<Record<string, unknown>>;
    }>(`/v1/notifications${q}`, {}, { asHuman: Boolean(this.humanIdentityHeader) });
  }

  markNotificationsRead(body: { id?: number; all?: boolean }) {
    return this.request<{ ok: true; marked: number }>(
      "/v1/notifications/mark-read",
      { method: "POST", body: JSON.stringify(body) },
      { asHuman: Boolean(this.humanIdentityHeader) },
    );
  }

  listMyTokens() {
    return this.request<{
      user: { id: string; email: string; name: string };
      items: Array<{
        id: string;
        userId: string;
        name: string;
        tokenPrefix: string;
        scopes: string[];
        expiresAt: string | null;
        revokedAt: string | null;
        lastUsedAt: string | null;
        createdAt: string;
      }>;
    }>("/v1/me/tokens", {}, { asHuman: Boolean(this.humanIdentityHeader) });
  }

  createMyToken(body: {
    name: string;
    scopes?: string[];
    expiresAt?: string | null;
  }) {
    return this.request<{
      id: string;
      userId: string;
      name: string;
      tokenPrefix: string;
      scopes: string[];
      expiresAt: string | null;
      revokedAt: string | null;
      lastUsedAt: string | null;
      createdAt: string;
      token: string;
    }>(
      "/v1/me/tokens",
      { method: "POST", body: JSON.stringify(body) },
      { asHuman: Boolean(this.humanIdentityHeader) },
    );
  }

  revokeMyToken(id: string) {
    return this.request<{
      id: string;
      userId: string;
      name: string;
      tokenPrefix: string;
      scopes: string[];
      expiresAt: string | null;
      revokedAt: string | null;
      lastUsedAt: string | null;
      createdAt: string;
    }>(
      `/v1/me/tokens/${encodeURIComponent(id)}/revoke`,
      { method: "POST", body: "{}" },
      { asHuman: Boolean(this.humanIdentityHeader) },
    );
  }
}
