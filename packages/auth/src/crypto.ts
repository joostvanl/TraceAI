import { createHash, randomBytes } from "node:crypto";
import { TRACEAI_TOKEN_PREFIX } from "./types.js";

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export function generateRawToken(): string {
  // ~32 bytes → 43 base64url chars
  return `${TRACEAI_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function tokenPrefixHint(rawToken: string): string {
  return rawToken.slice(0, 12);
}

export function isTraceaiToken(value: string): boolean {
  return value.startsWith(TRACEAI_TOKEN_PREFIX) && value.length > 20;
}
