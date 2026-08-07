#!/usr/bin/env node
import { createAuthStore, loadEnv } from "../env.js";

function arg(name: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  throw new Error(`Missing --${name}`);
}

const env = loadEnv();
const store = createAuthStore(env);
const email = arg("email");
const name = arg("name");
const existing = store.getUserByEmail(email);
if (existing) {
  console.error(`User already exists: ${existing.id}`);
  process.exit(1);
}
const user = store.createUser({ email, name });
console.log(JSON.stringify(user, null, 2));
store.close();
