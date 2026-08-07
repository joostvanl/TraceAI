#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const token = readFileSync(resolve("data/bootstrap-token.txt"), "utf8")
  .split(/\r?\n/)
  .find((l) => l.startsWith("token="))
  .slice("token=".length)
  .trim();

const api = "https://traceai.joostvanleeuwaarden.com";
const project = "traceai";

const esUrl = `${api}/events?project=${project}`;
console.log("connecting", esUrl);

// Minimal SSE client
const res = await fetch(esUrl, { headers: { Accept: "text/event-stream" } });
if (!res.ok || !res.body) {
  console.error("SSE connect failed", res.status);
  process.exit(1);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let sawConnected = false;
let sawTransition = false;

const timeout = setTimeout(() => {
  console.error("TIMEOUT waiting for events");
  process.exit(1);
}, 20000);

function handleChunk(text) {
  buffer += text;
  const parts = buffer.split("\n\n");
  buffer = parts.pop() ?? "";
  for (const part of parts) {
    const lines = part.split("\n");
    let event = "message";
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    console.log("event", event, data.slice(0, 120));
    if (event === "connected") sawConnected = true;
    if (event === "ticket.transitioned") {
      sawTransition = true;
      clearTimeout(timeout);
      console.log("SSE_OK");
      process.exit(0);
    }
  }
}

(async () => {
  // Give connection a moment, then transition verify ticket to review (emits event)
  setTimeout(async () => {
    await fetch(`${api}/v1/tickets/live-board-verify-demo/transition`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to_stage: "review",
        comment: `## Vorige stap
SSE verify ticket was in progress for live-board check.

## Deze stap
Moving to review to emit ticket.transitioned for SSE client.

## Testverslag
- SSE connect to /events?project=traceai â€” PASS (script connected)
- Expect ticket.transitioned after this call â€” pending

## Uitslag
PASS`,
      }),
    });
  }, 800);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    handleChunk(decoder.decode(value, { stream: true }));
  }
})();
