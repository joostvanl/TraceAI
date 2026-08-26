import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
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

const AGENT_API_CIPHER = "aes-256-gcm";
const AGENT_API_NONCE_BYTES = 12;
const AGENT_API_TAG_BYTES = 16;

/** SHA-256 of the configured secret → 32-byte AES-256 key. */
export function deriveAgentApiKeyMaterial(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function last4OfSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length <= 4 ? trimmed : trimmed.slice(-4);
}

/**
 * Encrypt a provider API key at rest. Ciphertext is `enc || authTag`; never log
 * plaintext or ciphertext.
 */
export function encryptAgentApiKey(
  plaintext: string,
  secret: string,
): { ciphertext: Buffer; nonce: Buffer } {
  const key = deriveAgentApiKeyMaterial(secret);
  const nonce = randomBytes(AGENT_API_NONCE_BYTES);
  const cipher = createCipheriv(AGENT_API_CIPHER, key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]),
    nonce,
  };
}

export function decryptAgentApiKey(
  ciphertext: Buffer,
  nonce: Buffer,
  secret: string,
): string {
  const key = deriveAgentApiKeyMaterial(secret);
  const buf = Buffer.from(ciphertext);
  if (buf.length <= AGENT_API_TAG_BYTES) {
    throw new Error("undecryptable");
  }
  const tag = buf.subarray(buf.length - AGENT_API_TAG_BYTES);
  const data = buf.subarray(0, buf.length - AGENT_API_TAG_BYTES);
  const decipher = createDecipheriv(AGENT_API_CIPHER, key, Buffer.from(nonce));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}
