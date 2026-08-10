#!/usr/bin/env node
/**
 * Migrate legacy shared Aurora `app_login`/`default` into a personal
 * `traceai_user` + project_memberships (admin on every project).
 *
 * Password cannot be copied from Aurora (hash-only). Provide a new password;
 * after cutover, personal login takes precedence when any active user exists.
 *
 *   pnpm --filter @traceai/api migrate-app-login -- --username joost --password '…'
 */
import { createTraceService, loadEnv } from "../env.js";

function arg(name: string, fallback?: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]!;
  if (fallback) return fallback;
  throw new Error(`Missing --${name}`);
}

const env = loadEnv();
const service = createTraceService(env);
const username = arg("username");
const password = arg("password");
const displayName = arg("display-name", username);

const existing = await service.findTraceaiUserByUsername(username);
let user = existing;
if (!user) {
  user = await service.createTraceaiUser({
    username,
    password,
    display_name: displayName,
    is_platform_admin: true,
    status: "active",
  });
  console.log(`Created traceai_user ${user.slug}`);
} else {
  await service.updateTraceaiUser(user.slug, {
    password,
    display_name: displayName,
    is_platform_admin: true,
    status: "active",
  });
  console.log(`Updated existing traceai_user ${user.slug}`);
}

const projects = await service.listProjects();
for (const project of projects) {
  const membership = await service.setProjectMembership({
    project: project.slug,
    user: user.slug,
    role: "admin",
  });
  console.log(`Membership ${membership.slug} → admin`);
}

console.log(
  "Done. Personal login is now preferred. Legacy app_login remains as fallback only when no personal users exist.",
);
