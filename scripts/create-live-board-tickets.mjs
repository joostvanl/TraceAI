#!/usr/bin/env node
/**
 * Create live-board feature tickets via TraceAI API.
 * Reads token from data/bootstrap-token.txt (never prints it).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const token = readFileSync(resolve("data/bootstrap-token.txt"), "utf8")
  .split(/\r?\n/)
  .find((l) => l.startsWith("token="))
  ?.slice("token=".length)
  .trim();
if (!token) {
  console.error("Missing token in data/bootstrap-token.txt");
  process.exit(1);
}

const api = process.env.TRACEAI_API_URL ?? "http://127.0.0.1:3847";
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

async function createTicket(body) {
  const res = await fetch(`${api}/v1/tickets`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function comment(ticket, body) {
  const res = await fetch(`${api}/v1/comments`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ticket, body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

const tickets = [
  {
    project: "traceai",
    slug: "live-board-sse-eventbus",
    title: "Live board: SSE event bus in TraceAI API",
    priority: "high",
    stage: "todo",
    description: `## Context
TraceAI humans watch a read-only kanban board in the Next.js UI. Agents change ticket stages via the TraceAI API/MCP. Today the board only updates on a full page reload. We need **server push** so cards move live when an agent transitions a ticket — without polling or continuous refresh.

## Goal
Add a Server-Sent Events (SSE) event bus to \`apps/api\` that broadcasts ticket domain events whenever the API mutates tickets.

## What to implement
1. Create an in-process pub/sub module (e.g. \`apps/api/src/events.ts\`) with \`subscribe(listener)\` and \`publish(event)\`.
2. Define event payload shape (JSON):
   - \`type\`: \`ticket.created\` | \`ticket.updated\` | \`ticket.transitioned\` | \`ticket.commented\`
   - \`project\`: project slug
   - \`ticket\`: \`{ slug, title, stage, priority, created_by }\`
   - \`from_stage\` / \`to_stage\` when type is \`ticket.transitioned\`
   - \`at\`: ISO timestamp
3. Call \`publish\` after successful ticket create, update, transition, and comment in \`apps/api/src/app.ts\`.
4. Expose **public** SSE endpoint \`GET /events?project={slug}\` (no TraceAI bearer required — board is read-only). Filter stream by project when query present.
5. Enable CORS for browser origins used by the UI (\`http://localhost:3000\`, \`http://127.0.0.1:3010\`, and configurable list).
6. Document the endpoint in README briefly.

## Out of scope
- WebSocket
- Persisting event history
- Authenticating the SSE stream

## Acceptance criteria
- Connecting with \`EventSource\` to \`/events?project=traceai\` receives an event within ~1s after \`transition_ticket\` / API transition for that project.
- Events for other projects are not delivered when \`project=\` filter is set.
- API still works if nobody is subscribed (publish is fire-and-forget).
- No Aurora credentials appear in the browser or SSE payload.
`,
  },
  {
    project: "traceai",
    slug: "live-board-ui-client",
    title: "Live board: client UI moves cards on SSE events",
    priority: "high",
    stage: "backlog",
    description: `## Context
Depends on ticket \`live-board-sse-eventbus\`. The project board page (\`apps/web/src/app/projects/[slug]/page.tsx\`) currently server-renders static columns. It must become a live board that reacts to SSE without full page refresh.

## Goal
When an agent transitions a ticket, the card animates/moves from the old workflow column to the new one on an open board page.

## What to implement
1. Add env \`NEXT_PUBLIC_TRACEAI_EVENTS_URL\` (default \`http://127.0.0.1:3847/events\`).
2. Split the board into:
   - Server component: load initial board data via Aurora public API (existing \`getProjectBoard\`).
   - Client component \`LiveBoard\`: receives initial stages + tickets, opens \`EventSource\` to \`{EVENTS_URL}?project={slug}\`.
3. On \`ticket.transitioned\` / \`ticket.created\` / \`ticket.updated\`:
   - Update local ticket state (move between stage buckets).
   - Update column counts.
   - Apply a short CSS transition/highlight so the move is visible (do not reload the page).
4. Handle SSE reconnect (browser EventSource reconnects automatically; show a small "live" / "reconnecting" indicator).
5. On \`ticket.created\` for this project, insert the card into the correct stage column.
6. Keep ticket detail pages as-is (optional: no SSE required for this ticket).

## Acceptance criteria
- With the board open on \`/projects/traceai\`, transitioning a ticket via MCP/API moves the card to the new column without a browser refresh.
- Creating a ticket via API appears in the correct column while the board stays open.
- Closing the tab closes the EventSource (no leaked listeners in React strict mode).
- Board still works if the events URL is unreachable (initial SSR data remains; show offline indicator).
`,
  },
  {
    project: "traceai",
    slug: "live-board-verify-demo",
    title: "Live board: end-to-end verify and demo script",
    priority: "medium",
    stage: "backlog",
    description: `## Context
Depends on \`live-board-sse-eventbus\` and \`live-board-ui-client\`.

## Goal
Prove live transitions work and leave a repeatable demo path for humans and agents.

## What to implement
1. Restart TraceAI API and web UI with the new events URL configured.
2. Open \`/projects/traceai\` in a browser.
3. From a terminal/agent, transition a ticket (or create then transition) and confirm the card moves live.
4. Add a short "Live board" note on the homepage connect section: events URL + that the board updates via SSE.
5. Optional: \`scripts/demo-live-transition.mjs\` that transitions a demo ticket twice with a delay for screen recording.

## Acceptance criteria
- Manual or scripted demo shows a card moving between columns without refresh.
- Homepage mentions live board / SSE so a new agent knows the board is realtime.
- Feature tickets themselves are transitioned with comments describing completed work.
`,
  },
];

for (const t of tickets) {
  const created = await createTicket(t);
  console.log("created", created.slug, "stage", created.stage);
  await comment(
    created.slug,
    [
      "## Intake",
      "",
      "Ticket aangemaakt in **backlog/todo** als startpunt voor de live-board feature.",
      "Nog geen implementatie gedaan in deze stap — alleen scope en acceptatiecriteria vastgelegd zodat een agent zonder eerdere chatcontext zelfstandig kan starten.",
      "",
      `Volgende toegestane stap: trek dit ticket naar \`in_progress\` wanneer je eraan begint, en documenteer in een comment wat de vorige stap opleverde.`,
    ].join("\n"),
  );
}

console.log("TICKETS_CREATED");
