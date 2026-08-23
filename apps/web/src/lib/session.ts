import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { TraceApiClient, TraceApiError, type UiIdentity } from "@traceai/core";

export { cookieShouldBeSecure, sessionCookieOptions } from "./session-cookie";

export const SESSION_COOKIE = "traceai_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export type SessionIdentity = UiIdentity;

function createApiClient(): TraceApiClient | null {
  const apiUrl = process.env.TRACEAI_API_URL?.replace(/\/$/, "");
  const token = process.env.TRACEAI_TOKEN;
  if (!apiUrl || !token?.startsWith("trc_")) return null;
  return new TraceApiClient({ apiUrl, token });
}

/**
 * HMAC key for the session cookie. Independent of Aurora password so Edge
 * middleware can verify sync; rotating this invalidates open sessions.
 * Also used to sign human-identity headers to the API.
 */
export function sessionSecret(): string | null {
  const explicit = process.env.TRACEAI_SESSION_SECRET?.trim();
  return explicit || null;
}

function safeEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export async function isLoginConfigured(): Promise<boolean> {
  const client = createApiClient();
  if (!client || !sessionSecret()) return false;
  try {
    const status = await client.uiLoginStatus();
    return status.configured;
  } catch (error) {
    // A failing status check looks identical to "not configured" in the UI,
    // so surface it in the logs instead of silently redirecting to /login.
    console.error("[traceai] ui login status failed:", error);
    return false;
  }
}

export async function verifyCredentials(
  user: string,
  password: string,
): Promise<
  | { ok: true; user: string; identity: SessionIdentity }
  | { ok: false; configured: boolean }
> {
  const client = createApiClient();
  if (!client || !sessionSecret()) {
    return { ok: false, configured: false };
  }
  try {
    const result = await client.verifyUiLogin({ username: user, password });
    return { ok: true, user: result.user, identity: result.identity };
  } catch (error) {
    if (error instanceof TraceApiError) {
      if (error.status === 503 || error.code === "NOT_CONFIGURED") {
        return { ok: false, configured: false };
      }
      return { ok: false, configured: true };
    }
    return { ok: false, configured: false };
  }
}

export function createSessionToken(identity: SessionIdentity): string {
  const secret = sessionSecret();
  if (!secret) throw new Error("TRACEAI_SESSION_SECRET is not set");
  const payload = Buffer.from(
    JSON.stringify({
      user: identity.user,
      slug: identity.slug,
      display_name: identity.display_name,
      is_platform_admin: identity.is_platform_admin,
      mode: identity.mode,
      exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
    }),
    "utf8",
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function identityFromSessionToken(
  token: string | undefined,
): SessionIdentity | null {
  if (!token) return null;
  const secret = sessionSecret();
  if (!secret) return null;

  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!safeEqual(signature, sign(payload, secret))) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<SessionIdentity> & { exp?: unknown };
    if (typeof parsed.user !== "string" || !parsed.user) return null;
    if (typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
    const mode = parsed.mode === "personal" || parsed.mode === "legacy"
      ? parsed.mode
      : "legacy";
    return {
      user: parsed.user,
      slug: typeof parsed.slug === "string" && parsed.slug ? parsed.slug : null,
      display_name:
        typeof parsed.display_name === "string" && parsed.display_name
          ? parsed.display_name
          : parsed.user,
      is_platform_admin: parsed.is_platform_admin === true || mode === "legacy",
      mode,
    };
  } catch {
    return null;
  }
}

/** @deprecated Prefer getSessionIdentity(); kept for username-only callers. */
export function userFromSessionToken(token: string | undefined): string | null {
  return identityFromSessionToken(token)?.user ?? null;
}

export async function getSessionIdentity(): Promise<SessionIdentity | null> {
  const store = await cookies();
  return identityFromSessionToken(store.get(SESSION_COOKIE)?.value);
}

export async function getSessionUser(): Promise<string | null> {
  const identity = await getSessionIdentity();
  return identity?.user ?? null;
}

export function signHumanIdentityHeader(identity: SessionIdentity): string {
  const secret = sessionSecret();
  if (!secret) throw new Error("TRACEAI_SESSION_SECRET is not set");
  const payload = Buffer.from(
    JSON.stringify({
      user: identity.user,
      slug: identity.slug,
      display_name: identity.display_name,
      is_platform_admin: identity.is_platform_admin,
      mode: identity.mode,
      exp: Date.now() + 60_000,
    }),
    "utf8",
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

