export type TraceApiClientOptions = {
  apiUrl: string;
  token: string;
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

  constructor(options: TraceApiClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "");
    this.token = options.token;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
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

  listTickets(project: string, stage?: string) {
    const params = new URLSearchParams({ project });
    if (stage) params.set("stage", stage);
    return this.request<unknown[]>(`/v1/tickets?${params}`);
  }

  getTicket(slug: string) {
    return this.request<unknown>(`/v1/tickets/${encodeURIComponent(slug)}`);
  }

  createTicket(body: Record<string, unknown>) {
    return this.request<unknown>("/v1/tickets", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  updateTicket(slug: string, body: Record<string, unknown>) {
    return this.request<unknown>(`/v1/tickets/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  transitionTicket(
    slug: string,
    toStage: string,
    comment?: string,
    tokens?: { tokens_estimate?: number; tokens_used?: number },
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
        }),
      },
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

  me() {
    return this.request<unknown>("/v1/me");
  }

  uiLoginStatus() {
    return this.request<{ configured: boolean }>("/v1/ui/login/status");
  }

  verifyUiLogin(body: { username: string; password: string }) {
    return this.request<{ ok: true; user: string }>("/v1/ui/login/verify", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}
