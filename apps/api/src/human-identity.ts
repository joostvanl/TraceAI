import { createHmac, timingSafeEqual } from "node:crypto";
import type { ProjectRole } from "@traceai/core";

export type HumanIdentity = {
  user: string;
  slug: string | null;
  display_name: string;
  is_platform_admin: boolean;
  mode: "personal" | "legacy";
};

export const HUMAN_IDENTITY_HEADER = "x-traceai-human-identity";

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Sign a human identity for the web→API proxy (uses TRACEAI_SESSION_SECRET). */
export function signHumanIdentity(
  identity: HumanIdentity,
  secret: string,
  maxAgeMs = 60_000,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      ...identity,
      exp: Date.now() + maxAgeMs,
    }),
    "utf8",
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function parseHumanIdentityHeader(
  header: string | undefined,
  secret: string | null | undefined,
): HumanIdentity | null {
  if (!header || !secret) return null;
  const separator = header.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = header.slice(0, separator);
  const signature = header.slice(separator + 1);
  if (!safeEqual(signature, sign(payload, secret))) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<HumanIdentity> & { exp?: unknown };
    if (typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
    if (typeof parsed.user !== "string" || !parsed.user.trim()) return null;
    if (parsed.mode !== "personal" && parsed.mode !== "legacy") return null;
    return {
      user: parsed.user.trim(),
      slug: typeof parsed.slug === "string" && parsed.slug ? parsed.slug : null,
      display_name:
        typeof parsed.display_name === "string" && parsed.display_name.trim()
          ? parsed.display_name.trim()
          : parsed.user.trim(),
      is_platform_admin: parsed.is_platform_admin === true,
      mode: parsed.mode,
    };
  } catch {
    return null;
  }
}

export function attributionName(identity: HumanIdentity | null, fallback: string): string {
  if (!identity) return fallback;
  return identity.slug || identity.user;
}

export type { ProjectRole };
