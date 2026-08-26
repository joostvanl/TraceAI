import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { cursorFollowUpForClaimer } from "./agent-api-keys.js";
import { createAuthStore, createTraceService, loadEnv } from "./env.js";
import { configureEventBus } from "./events.js";
import { configureNotificationStore } from "./notifications.js";
import {
  configureNudgeQueueStore,
  startNudgeQueuePoller,
} from "./nudge-queue.js";

const env = loadEnv();
const authStore = createAuthStore(env);
const service = createTraceService(env);
configureEventBus({ dbPath: env.eventsDbPath, pollMs: env.eventsPollMs });
configureNotificationStore(env.notificationsDbPath);
const nudgeQueue = configureNudgeQueueStore(env.nudgeQueueDbPath);
const app = createApp({ authStore, service, nudgeQueue });
startNudgeQueuePoller({
  store: nudgeQueue,
  getClient: (ticket, fallbackUserId) =>
    cursorFollowUpForClaimer(authStore, ticket, { fallbackUserId }),
  loadTicket: async (slug) => {
    const wrapped = await service.getTicket(slug);
    return wrapped?.ticket ?? null;
  },
  addComment: async (input) => {
    await service.addComment({ ...input, author: "traceai" });
  },
});

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`TraceAI API listening on http://127.0.0.1:${info.port}`);
  console.log(`Auth DB: ${env.authDbPath}`);
  console.log(`Events DB: ${env.eventsDbPath}`);
  console.log(`Notifications DB: ${env.notificationsDbPath}`);
  console.log(`Nudge queue DB: ${env.nudgeQueueDbPath}`);
});
