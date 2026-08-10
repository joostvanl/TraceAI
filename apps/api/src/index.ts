import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createAuthStore, createTraceService, loadEnv } from "./env.js";
import { configureEventBus } from "./events.js";
import { configureNotificationStore } from "./notifications.js";

const env = loadEnv();
const authStore = createAuthStore(env);
const service = createTraceService(env);
configureEventBus({ dbPath: env.eventsDbPath, pollMs: env.eventsPollMs });
configureNotificationStore(env.notificationsDbPath);
const app = createApp({ authStore, service });

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`TraceAI API listening on http://127.0.0.1:${info.port}`);
  console.log(`Auth DB: ${env.authDbPath}`);
  console.log(`Events DB: ${env.eventsDbPath}`);
  console.log(`Notifications DB: ${env.notificationsDbPath}`);
});
