import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "traceai_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

type UiCredentials = {
  user: string;
  password: string;
};

export function readUiCredentials(): UiCredentials | null {
  const user = process.env.TRACEAI_UI_USER?.trim();
  const password = process.env.TRACEAI_UI_PASSWORD;
  if (!user || !password) return null;
  return { user, password };
}

export function isLoginConfigured(): boolean {
  return readUiCredentials() !== null;
}

function sessionSecret(): string | null {
  const explicit = process.env.TRACEAI_SESSION_SECRET?.trim();
  if (explicit) return explicit;
  const credentials = readUiCredentials();
  // Deriving from the password means rotating it also invalidates existing sessions.
  return credentials ? `${credentials.user}:${credentials.password}` : null;
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

export function verifyCredentials(user: string, password: string): boolean {
  const expected = readUiCredentials();
  if (!expected) return false;
  // Evaluate both halves so a wrong username and a wrong password cost the same.
  const userMatches = safeEqual(user, expected.user);
  const passwordMatches = safeEqual(password, expected.password);
  return userMatches && passwordMatches;
}

export function createSessionToken(user: string): string {
  const secret = sessionSecret();
  if (!secret) throw new Error("UI login is not configured");
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
