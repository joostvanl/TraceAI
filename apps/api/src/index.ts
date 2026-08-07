import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createAuthStore, createTraceService, loadEnv } from "./env.js";

const env = loadEnv();
const authStore = createAuthStore(env);
const service = createTraceService(env);
const app = createApp({ authStore, service });

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`TraceAI API listening on http://127.0.0.1:${info.port}`);
  console.log(`Auth DB: ${env.authDbPath}`);
});
