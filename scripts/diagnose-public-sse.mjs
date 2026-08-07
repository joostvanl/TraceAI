/**
 * Verifies the live-board plumbing end to end: subscribe to an API instance's
 * SSE stream, perform a write against another (or the same) instance, and report
 * whether the event arrives.
 *
 * Because the ticket event bus lives in-process, LISTEN_BASE must be the exact
 * API instance that WRITE_BASE points at — a mismatch is silent, since every
 * instance shares one Aurora store and so a page refresh still looks correct.
 *
 *   node scripts/diagnose-public-sse.mjs
 *   LISTEN_BASE=http://127.0.0.1:3847 node scripts/diagnose-public-sse.mjs
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function mcpEnv() {
  try {
    const raw = readFileSync(join(homedir(), ".cursor", "mcp.json"), "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, "")).mcpServers?.traceai?.env ?? {};
  } catch {
    return {};
  }
}

const fallback = mcpEnv();
const base = (process.env.WRITE_BASE ?? fallback.TRACEAI_API_URL ?? "").replace(/\/$/, "");
const token = process.env.TRACEAI_TOKEN ?? fallback.TRACEAI_TOKEN;
const project = process.env.TRACEAI_PROJECT ?? "traceai";

if (!base || !token) {
  console.error("Missing API base or token: set WRITE_BASE and TRACEAI_TOKEN.");
  process.exit(2);
}

const listenBase = (process.env.LISTEN_BASE ?? base).replace(/\/$/, "");

console.log("write base :", base);
console.log("listen base:", listenBase);

const authHeaders = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

const tickets = await (
  await fetch(`${base}/v1/tickets?project=${project}`, { headers: authHeaders })
).json();

const candidate = tickets.find((t) => t.stage !== "done") ?? tickets[0];
console.log("target ticket:", candidate.slug, "stage:", candidate.stage);

const started = Date.now();
const controller = new AbortController();
const res = await fetch(`${listenBase}/events?project=${project}`, {
  headers: { Accept: "text/event-stream" },
  signal: controller.signal,
});
console.log("SSE status:", res.status, res.headers.get("content-type"));

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let sawConnected = false;
let sawUpdate = false;

const timeout = setTimeout(() => {
  console.log("RESULT: TIMEOUT — no ticket.updated received in 20s");
  console.log("sawConnected:", sawConnected);
  controller.abort();
  process.exit(sawUpdate ? 0 : 1);
}, 20000);

(async () => {
  // Wait a moment so the SSE subscription is registered, then write.
  await new Promise((r) => setTimeout(r, 1200));
  const patch = await fetch(`${base}/v1/tickets/${candidate.slug}`, {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify({
      priority: process.env.SET_PRIORITY ?? candidate.priority ?? "medium",
    }),
  });
  console.log("write status:", patch.status, `(+${Date.now() - started}ms)`);
})();

try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      let event = "message";
      for (const line of part.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
      }
      console.log(`event: ${event} (+${Date.now() - started}ms)`);
      if (event === "connected") sawConnected = true;
      if (event === "ticket.updated" || event === "ticket.transitioned") {
        sawUpdate = true;
        clearTimeout(timeout);
        console.log("RESULT: LIVE_SSE_OK — event delivered through Cloudflare");
        controller.abort();
        process.exit(0);
      }
    }
  }
} catch (error) {
  if (!sawUpdate) {
    console.log("stream error:", String(error).slice(0, 120));
  }
}
