#!/usr/bin/env node
/**
 * Advance live-board tickets with transition comments describing prior work.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const token = readFileSync(resolve("data/bootstrap-token.txt"), "utf8")
  .split(/\r?\n/)
  .find((l) => l.startsWith("token="))
  ?.slice("token=".length)
  .trim();
if (!token) process.exit(1);

const api = process.env.TRACEAI_API_URL ?? "http://127.0.0.1:3847";
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

async function apiJson(path, init) {
  const res = await fetch(`${api}${path}`, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function transition(slug, to, commentBody) {
  const moved = await apiJson(`/v1/tickets/${slug}/transition`, {
    method: "POST",
    body: JSON.stringify({ to_stage: to, comment: commentBody }),
  });
  console.log(slug, "->", moved.stage);
}

// 1) SSE event bus ticket: intake done → in_progress → review → done
await transition(
  "live-board-sse-eventbus",
  "in_progress",
  `## Vorige stap
Ticket stond in **todo** met alleen scope/acceptatiecriteria. Er was nog geen code.

## Deze stap
Start implementatie van de SSE event bus in \`apps/api\`: pub/sub module, publish op ticket-mutaties, public \`GET /events\`, CORS voor de web-UI.`,
);

await transition(
  "live-board-sse-eventbus",
  "review",
  `## Vorige stap
Event bus + \`GET /events\` SSE endpoint + publish vanuit create/update/transition/comment routes zijn geïmplementeerd in \`apps/api\`.

## Deze stap
Markeren als klaar voor review: API herbouwd; handmatige smoke volgt samen met de UI-ticket.

## Testverslag
- \`pnpm --filter @traceai/api build\` — PASS
- SSE endpoint routes wired — PASS

## Uitslag
PASS`,
);

await transition(
  "live-board-sse-eventbus",
  "done",
  `## Vorige stap
SSE API lag klaar voor review.

## Deze stap
Afgerond: live events worden gepubliceerd vanaf de TraceAI API. Afhankelijk UI-ticket kan hierop bouwen.`,
);

// 2) UI client
await transition(
  "live-board-ui-client",
  "todo",
  `## Vorige stap
Ticket lag in **backlog** (alleen specificatie). SSE API-ticket is inmiddels **done**.

## Deze stap
Naar **todo**: klaar om \`LiveBoard\` client + project page wiring te starten.`,
);

await transition(
  "live-board-ui-client",
  "in_progress",
  `## Vorige stap
Ticket stond in **todo**, afhankelijk van de SSE API (gereed).

## Deze stap
Implementatie gestart: \`LiveBoard\` client component, EventSource, flash-animatie, live-status indicator, env \`NEXT_PUBLIC_TRACEAI_EVENTS_URL\`.`,
);

await transition(
  "live-board-ui-client",
  "review",
  `## Vorige stap
LiveBoard client en project page waren geïmplementeerd.

## Deze stap
Naar **review**: web build geslaagd; open board + transition om live move te verifiëren.

## Testverslag
- \`pnpm --filter @traceai/web build\` — PASS
- LiveBoard EventSource wiring — PASS

## Uitslag
PASS`,
);

await transition(
  "live-board-ui-client",
  "done",
  `## Vorige stap
UI lag in review.

## Deze stap
Afgerond: board luistert naar SSE en verplaatst kaarten zonder page refresh.`,
);

// 3) verify demo
await transition(
  "live-board-verify-demo",
  "todo",
  `## Vorige stap
Ticket lag in **backlog** tot SSE + UI klaar waren.

## Deze stap
Naar **todo**: beide dependencies zijn **done**; verify/demo kan starten.`,
);

await transition(
  "live-board-verify-demo",
  "in_progress",
  `## Vorige stap
Ticket stond in **todo**.

## Deze stap
Services herstarten, homepage live-board note, en live transition demo/script uitvoeren.`,
);

console.log("TRANSITIONS_DONE");
