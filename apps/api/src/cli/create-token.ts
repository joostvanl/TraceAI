#!/usr/bin/env node
import { DEFAULT_AGENT_SCOPES, type Scope } from "@traceai/auth";
import { createAuthStore, loadEnv } from "../env.js";

function arg(name: string, fallback?: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  if (fallback != null) return fallback;
  throw new Error(`Missing --${name}`);
}

const env = loadEnv();
const store = createAuthStore(env);

const userId = (() => {
  if (process.argv.includes("--userId")) return arg("userId");
  const email = arg("email");
  const user = store.getUserByEmail(email);
  if (!user) throw new Error(`User not found: ${email}`);
  return user.id;
})();

const scopesArg = process.argv.includes("--scopes")
  ? (arg("scopes").split(",").map((s) => s.trim()) as Scope[])
  : DEFAULT_AGENT_SCOPES;

const created = store.createToken({
  userId,
  name: arg("name", "agent"),
  scopes: scopesArg,
});

console.log(
  JSON.stringify(
    {
      id: created.id,
      userId: created.userId,
      name: created.name,
      scopes: created.scopes,
      tokenPrefix: created.tokenPrefix,
      token: created.token,
    },
    null,
    2,
  ),
);
store.close();
