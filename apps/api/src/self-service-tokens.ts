import {
  DEFAULT_AGENT_SCOPES,
  type AuthStore,
  type Scope,
  type TraceUser,
} from "@traceai/auth";
import type { TraceService } from "@traceai/core";
import type { HumanIdentity } from "./human-identity.js";

/** Deterministic AuthStore email for a personal UI user (Aurora slug). */
export function authEmailForUiSlug(slug: string): string {
  return `ui+${slug.trim().toLowerCase()}@users.traceai.local`;
}

/** Self-service may never grant `admin`. */
export function sanitizeSelfServiceScopes(
  input?: string[] | null,
): Scope[] {
  const allowed = new Set<string>(DEFAULT_AGENT_SCOPES);
  if (!input?.length) return [...DEFAULT_AGENT_SCOPES];
  const filtered = input.filter((s): s is Scope => allowed.has(s));
  return filtered.length > 0 ? filtered : [...DEFAULT_AGENT_SCOPES];
}

export type SelfServiceUserResult =
  | { ok: true; user: TraceUser; uiSlug: string }
  | { ok: false; status: 403 | 404; message: string; code: string };

/**
 * Resolve or auto-provision the AuthStore user for a personal web login.
 * Legacy shared login is blocked (no safe ownership boundary).
 */
export async function resolveSelfServiceAuthUser(
  service: TraceService,
  authStore: AuthStore,
  human: HumanIdentity | null,
): Promise<SelfServiceUserResult> {
  if (!human || human.mode !== "personal" || !human.slug) {
    return {
      ok: false,
      status: 403,
      message:
        "API tokens require a personal TraceAI login (shared/legacy login cannot create tokens)",
      code: "PERSONAL_LOGIN_REQUIRED",
    };
  }

  const uiUser = await service.getTraceaiUser(human.slug);
  if (!uiUser || uiUser.fields.status !== "active") {
    return {
      ok: false,
      status: 404,
      message: "TraceAI user not found or disabled",
      code: "USER_NOT_FOUND",
    };
  }

  const email = authEmailForUiSlug(human.slug);
  const name =
    uiUser.fields.display_name?.trim() ||
    uiUser.fields.username?.trim() ||
    human.display_name ||
    human.slug;

  let user = authStore.getUserByEmail(email);
  if (!user) {
    user = authStore.createUser({ email, name });
  }

  return { ok: true, user, uiSlug: human.slug };
}
