import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { TraceApiClient, TraceApiError } from "@traceai/core";

export const SESSION_COOKIE = "traceai_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function createApiClient(): TraceApiClient | null {
  const apiUrl = process.env.TRACEAI_API_URL?.replace(/\/$/, "");
  const token = process.env.TRACEAI_TOKEN;
  if (!apiUrl || !token?.startsWith("trc_")) return null;
  return new TraceApiClient({ apiUrl, token });
}

/**
 * HMAC key for the session cookie. Independent of Aurora password so Edge
 * middleware can verify sync; rotating this invalidates open sessions.
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
  } catch {
    return false;
  }
}

export async function verifyCredentials(
  user: string,
  password: string,
): Promise<{ ok: true; user: string } | { ok: false; configured: boolean }> {
  const client = createApiClient();
  if (!client || !sessionSecret()) {
    return { ok: false, configured: false };
  }
  try {
    const result = await client.verifyUiLogin({ username: user, password });
    return { ok: true, user: result.user };
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

export function createSessionToken(user: string): string {
  const secret = sessionSecret();
  if (!secret) throw new Error("TRACEAI_SESSION_SECRET is not set");
  const payload = Buffer.from(
    JSON.stringify({
      user,
      exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
    }),
    "utf8",
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function userFromSessionToken(token: string | undefined): string | null {
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
    ) as { user?: unknown; exp?: unknown };
    if (typeof parsed.user !== "string" || !parsed.user) return null;
    if (typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
    return parsed.user;
  } catch {
    return null;
  }
}

export async function getSessionUser(): Promise<string | null> {
  const store = await cookies();
  return userFromSessionToken(store.get(SESSION_COOKIE)?.value);
}

export function sessionCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}
