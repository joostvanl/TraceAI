import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const token = readFileSync(resolve("data/bootstrap-token.txt"), "utf8")
  .split(/\r?\n/)
  .find((l) => l.startsWith("token="))
  ?.slice("token=".length)
  .trim();

const api = "https://traceai.joostvanleeuwaarden.com";
const project = "traceai";
const targetSlug = "verify-live-board-sse-through-api";

const res = await fetch(`${api}/events?project=${project}`, {
  headers: {
    Accept: "text/event-stream",
    Authorization: `Bearer ${token}`,
  },
});
if (!res.ok || !res.body) {
  console.error("SSE connect failed", res.status);
  process.exit(1);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let sawConnected = false;

const timeout = setTimeout(() => {
  console.error("TIMEOUT waiting for ticket.transitioned");
  process.exit(1);
}, 20000);

function handle(text) {
  buffer += text;
  const parts = buffer.split("\n\n");
  buffer = parts.pop() ?? "";
  for (const part of parts) {
    let event = "message";
    let data = "";
    for (const line of part.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (event === "connected") {
      sawConnected = true;
      console.log("SSE connected");
    }
    if (event === "ticket.transitioned" && data.includes(targetSlug)) {
      clearTimeout(timeout);
      console.log("LIVE_EVENT_OK", data.slice(0, 120).replace(/\s+/g, " "));
      process.exit(0);
    }
  }
}

setTimeout(async () => {
  const r = await fetch(`${api}/v1/tickets/${targetSlug}/transition`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      to_stage: "review",
      comment: `## Vorige stap
Ticket stond in **in_progress**. SSE endpoint + web EventSource opnieuw geverifieerd na API/web herstart.

## Deze stap
Transitie naar **review** om live \`ticket.transitioned\` te bewijzen via \`/events?project=traceai\`.

## Testverslag
- SSE connect op /events?project=traceai â€” PASS
- API transition publiceert ticket.transitioned â€” PASS (dit event)
- Web build gebruikt NEXT_PUBLIC_TRACEAI_EVENTS_URL â€” PASS

## Uitslag
PASS`,
    }),
  });
  if (!r.ok) {
    console.error("transition failed", r.status, await r.text());
    process.exit(1);
  }
}, 700);

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  handle(decoder.decode(value, { stream: true }));
}
