#!/usr/bin/env node
/**
 * Bootstrap first TraceAI admin user + token.
 * Usage:
 *   AURORA_USER_TOKEN=... pnpm --filter @traceai/api bootstrap -- --email you@example.com --name "Joost"
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALL_SCOPES } from "@traceai/auth";
import { createAuthStore, loadEnv } from "../env.js";

function arg(name: string, fallback?: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  if (fallback) return fallback;
  throw new Error(`Missing --${name}`);
}

const env = loadEnv();
const store = createAuthStore(env);

const email = arg("email", process.env.TRACEAI_BOOTSTRAP_EMAIL ?? "admin@traceai.local");
const name = arg("name", process.env.TRACEAI_BOOTSTRAP_NAME ?? "TraceAI Admin");

let user = store.getUserByEmail(email);
if (!user) {
  user = store.createUser({ email, name });
  console.log(`Created user ${user.id} <${user.email}>`);
} else {
  console.log(`Using existing user ${user.id} <${user.email}>`);
}

const created = store.createToken({
  userId: user.id,
  name: arg("token-name", "bootstrap"),
  scopes: [...ALL_SCOPES],
});

const outPath = resolve(process.cwd(), "../../data/bootstrap-token.txt");
writeFileSync(
  outPath,
  [
    `# TraceAI bootstrap token — store securely, shown once`,
    `email=${user.email}`,
    `userId=${user.id}`,
    `tokenId=${created.id}`,
    `token=${created.token}`,
    "",
  ].join("\n"),
  { encoding: "utf8" },
);

console.log("");
console.log("Raw TraceAI token (save now — not shown again):");
console.log(created.token);
console.log("");
console.log(`Also written to ${outPath}`);
store.close();
