export const TRACEAI_TOKEN_PREFIX = "trc_";

export const ALL_SCOPES = [
  "projects:read",
  "projects:write",
  "tickets:read",
  "tickets:write",
  "comments:write",
  "workflows:read",
  "workflows:write",
  "wiki:read",
  "wiki:write",
  "admin",
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

export const DEFAULT_AGENT_SCOPES: Scope[] = [
  "projects:read",
  "projects:write",
  "tickets:read",
  "tickets:write",
  "comments:write",
  "workflows:read",
  "workflows:write",
  "wiki:read",
  "wiki:write",
];

export type UserStatus = "active" | "disabled";

export type TraceUser = {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
};

export type TraceToken = {
  id: string;
  userId: string;
  name: string;
  tokenPrefix: string;
  tokenHash: string;
  scopes: Scope[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

export type TraceTokenPublic = Omit<TraceToken, "tokenHash">;

export type CreatedToken = TraceTokenPublic & {
  /** Raw secret — only available at creation time */
  token: string;
};

export type AuthActor = {
  userId: string;
  email: string;
  name: string;
  tokenId: string;
  scopes: Scope[];
};

export type AuditEntry = {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorUserId: string;
  actorTokenId: string;
  requestId: string;
  meta: string | null;
  createdAt: string;
};

export function hasScope(scopes: Scope[], required: Scope | Scope[]): boolean {
  const needed = Array.isArray(required) ? required : [required];
  if (scopes.includes("admin")) return true;
  return needed.every((s) => scopes.includes(s));
}

export function maskToken(token: string): string {
  if (token.length < 12) return `${TRACEAI_TOKEN_PREFIX}…`;
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

/** v1 writable provider. Page lists more; only this one stores a key. */
export const WRITABLE_AGENT_API_PROVIDERS = ["cursor"] as const;
export type WritableAgentApiProvider =
  (typeof WRITABLE_AGENT_API_PROVIDERS)[number];

export const KNOWN_AGENT_API_PROVIDERS = [
  "cursor",
  "claude_code",
  "codex",
] as const;
export type KnownAgentApiProvider = (typeof KNOWN_AGENT_API_PROVIDERS)[number];

export function isWritableAgentApiProvider(
  value: string,
): value is WritableAgentApiProvider {
  return (WRITABLE_AGENT_API_PROVIDERS as readonly string[]).includes(value);
}

export function isKnownAgentApiProvider(
  value: string,
): value is KnownAgentApiProvider {
  return (KNOWN_AGENT_API_PROVIDERS as readonly string[]).includes(value);
}

/** Public metadata — never includes the secret. */
export type AgentApiKeyMeta = {
  provider: string;
  configured: boolean;
  last4: string | null;
};
