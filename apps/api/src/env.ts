import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AuthStore } from "@traceai/auth";
import { TraceService } from "@traceai/core";

function loadDotEnv() {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "apps/api/.env"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

export type ApiEnv = {
  port: number;
  authDbPath: string;
  eventsDbPath: string;
  eventsPollMs: number;
  notificationsDbPath: string;
  auroraApiUrl: string;
  auroraToken: string;
  auroraWebsiteId?: string;
  auroraLocale: string;
};

export function loadEnv(): ApiEnv {
  loadDotEnv();
  const auroraToken =
    process.env.AURORA_MANAGEMENT_TOKEN ?? process.env.AURORA_USER_TOKEN;
  if (!auroraToken) {
    throw new Error(
      "API requires AURORA_MANAGEMENT_TOKEN or AURORA_USER_TOKEN (server-side only)",
    );
  }

  const root = existsSync(resolve(process.cwd(), "pnpm-workspace.yaml"))
    ? process.cwd()
    : resolve(process.cwd(), "../..");

  return {
    port: Number(process.env.PORT ?? 3847),
    authDbPath:
      process.env.TRACEAI_AUTH_DB ??
      resolve(root, "data", "traceai-auth.sqlite"),
    eventsDbPath:
      process.env.TRACEAI_EVENTS_DB ??
      resolve(root, "data", "traceai-events.sqlite"),
    eventsPollMs: Number(process.env.TRACEAI_EVENTS_POLL_MS ?? 750),
    notificationsDbPath:
      process.env.TRACEAI_NOTIFICATIONS_DB ??
      resolve(root, "data", "traceai-notifications.sqlite"),
    auroraApiUrl:
      process.env.AURORA_API_URL ??
      "https://aurora-api.joostvanleeuwaarden.com",
    auroraToken,
    auroraWebsiteId:
      process.env.AURORA_WEBSITE_ID ?? "cmsiyy8oy00quoc01zzam3t6p",
    auroraLocale: process.env.AURORA_LOCALE ?? "en-US",
  };
}

export function createAuthStore(env: ApiEnv) {
  return new AuthStore(env.authDbPath);
}

export function createTraceService(env: ApiEnv) {
  return new TraceService({
    apiUrl: env.auroraApiUrl,
    token: env.auroraToken,
    websiteId: env.auroraToken.startsWith("aur_u_")
      ? env.auroraWebsiteId
      : undefined,
    locale: env.auroraLocale,
  });
}
