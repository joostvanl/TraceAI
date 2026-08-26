import {
  decryptAgentApiKey,
  isWritableAgentApiProvider,
  KNOWN_AGENT_API_PROVIDERS,
  type AuthStore,
} from "@traceai/auth";
import {
  CursorCloudAgentClient,
  type CursorCloudFollowUp,
  type Ticket,
} from "@traceai/core";

/** Prefer a dedicated secret; fall back to the session HMAC (must be non-empty). */
export function agentApiEncryptionSecret(
  env: NodeJS.Dict<string> = process.env,
): string | null {
  const dedicated = env.TRACEAI_AGENT_API_SECRET?.trim();
  if (dedicated) return dedicated;
  const session = env.TRACEAI_SESSION_SECRET?.trim();
  return session || null;
}

export type ClaimerCursorKeySkip =
  | "no_claimer"
  | "no_key"
  | "no_secret"
  | "decrypt_failed";

export type ClaimerCursorKeyResult =
  | { ok: true; apiKey: string }
  | { ok: false; reason: ClaimerCursorKeySkip };

/**
 * Decrypt the claiming user's Cursor key. Safe for the live review path and a
 * later durable queue (TRA-113) — never reads `CURSOR_API_KEY`.
 */
export function resolveClaimerCursorApiKey(
  store: AuthStore,
  ticket: Pick<Ticket, "fields">,
  env: NodeJS.Dict<string> = process.env,
): ClaimerCursorKeyResult {
  const userId = ticket.fields.claimed_by_user_id?.trim();
  if (!userId) return { ok: false, reason: "no_claimer" };
  const record = store.getAgentApiKeyRecord(userId, "cursor");
  if (!record) return { ok: false, reason: "no_key" };
  const secret = agentApiEncryptionSecret(env);
  if (!secret) return { ok: false, reason: "no_secret" };
  try {
    const apiKey = decryptAgentApiKey(record.ciphertext, record.nonce, secret);
    if (!apiKey.trim()) return { ok: false, reason: "decrypt_failed" };
    return { ok: true, apiKey };
  } catch {
    return { ok: false, reason: "decrypt_failed" };
  }
}

export function cursorFollowUpForClaimer(
  store: AuthStore,
  ticket: Ticket,
  options?: {
    fetchImpl?: typeof fetch;
    log?: (message: string) => void;
    env?: NodeJS.Dict<string>;
  },
): CursorCloudFollowUp | null {
  const result = resolveClaimerCursorApiKey(store, ticket, options?.env);
  if (!result.ok) {
    const log = options?.log ?? ((message: string) => console.warn(message));
    log(
      `[traceai] cursor cloud nudge skipped (${result.reason}) for ${ticket.slug}`,
    );
    return null;
  }
  return new CursorCloudAgentClient(result.apiKey, options?.fetchImpl);
}

export function listedAgentApiProviders(
  store: AuthStore,
  userId: string,
): Array<{ provider: string; configured: boolean; last4: string | null }> {
  const saved = new Map(
    store.listAgentApiKeyMeta(userId).map((row) => [row.provider, row]),
  );
  return KNOWN_AGENT_API_PROVIDERS.map((provider) => {
    const row = saved.get(provider);
    if (row && isWritableAgentApiProvider(provider)) {
      return {
        provider,
        configured: true,
        last4: row.last4,
      };
    }
    return { provider, configured: false, last4: null };
  });
}
