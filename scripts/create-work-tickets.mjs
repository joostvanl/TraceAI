import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const token = readFileSync(resolve("data/bootstrap-token.txt"), "utf8")
  .split(/\r?\n/)
  .find((l) => l.startsWith("token="))
  ?.slice("token=".length)
  .trim();
if (!token) process.exit(1);

const api = "http://127.0.0.1:3847";
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function req(path, init) {
  const res = await fetch(`${api}${path}`, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function ensureTicket(slug, title, description, priority) {
  try {
    const t = await req("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({ project: "traceai", slug, title, description, priority }),
    });
    console.log("created", t.slug);
  } catch (e) {
    if (String(e).includes("already") || String(e).includes("409")) {
      console.log("exists", slug);
    } else {
      console.log("create-failed", slug, String(e).slice(0, 200));
    }
  }
}

async function transition(slug, to, comment) {
  await req(`/v1/tickets/${slug}/transition`, {
    method: "POST",
    body: JSON.stringify({ to_stage: to, comment }),
  });
  console.log(slug, "->", to);
}

const mcpDesc = `## Context
Agents connect to TraceAI through the \`user-traceai\` MCP server (\`packages/mcp/dist/index.js\`), which proxies to the TraceAI API on \`http://127.0.0.1:3847\`. An agent reported that the MCP returns \`TraceAI API 404\` for \`get_project\`, while the same token + endpoint returns 200 when called directly against the API. Because of the 404 the agent bypassed TraceAI (writing outside the API), which also broke the live board (no SSE events for out-of-band writes).

## Goal
Make the MCP path reliable again and document how to recover from a stale MCP process, so agents never silently bypass TraceAI.

## What to implement
1. Confirm root cause: the long-running MCP process in Cursor holds a stale build/env (old API URL/port) so it hits an unknown route and gets a bare 404, even though \`mcp.json\` points to 3847.
2. Verify current API + MCP token健康 with a diagnostic script (health, /v1/me, /v1/projects, /v1/projects/traceai).
3. Ensure \`packages/mcp/dist\` is rebuilt from current source.
4. Document the recovery step (reload MCP / Cursor window) in README + docs so a 404 is understood as "reload MCP", not "bypass TraceAI".
5. Improve the MCP error message to hint at reload when a 404 is received from the API root.

## Out of scope
- Rewriting the transport or auth model.

## Acceptance criteria
- Diagnostic script shows 200 for health, me, projects, and project-traceai with the MCP token.
- \`packages/mcp/dist/index.js\` matches current source.
- README/docs describe the "MCP 404 → reload MCP" recovery.
- After reloading MCP in Cursor, \`get_project traceai\` returns the project (no 404).`;

const sseDesc = `## Context
The read-only web board uses SSE (\`GET /events?project=...\`) published by the TraceAI API on ticket create/update/transition/comment. When an agent writes directly to Aurora (bypassing the TraceAI API, e.g. after an MCP 404), no event is published, so cards only move after a manual page refresh.

## Goal
Confirm the live path works end-to-end when writes go through the TraceAI API, and make it clear that only API/MCP writes are live.

## What to implement
1. Add/keep an SSE verification script that connects to \`/events?project=traceai\`, performs a transition via the API, and asserts a \`ticket.transitioned\` event arrives.
2. Confirm the web build points at \`NEXT_PUBLIC_TRACEAI_EVENTS_URL\` and reconnects after an API restart.
3. Document that Aurora-direct writes are NOT live; agents must use MCP/API.

## Out of scope
- Making Aurora-direct writes emit events (not feasible without API involvement).

## Acceptance criteria
- SSE script prints connected + ticket.transitioned and exits OK.
- Moving a ticket via the API visibly moves the card without refresh.
- Docs state that only API/MCP writes are reflected live.`;

const doneSortDesc = `## Context
On the project board, the \`Done\` column currently renders tickets in the global \`sort_order\` (creation order). The user wants the most recently completed ticket to appear at the top of the Done lane, ordered by the moment it entered the Done stage.

## Goal
Sort the Done lane by completion time descending (newest completion on top), both on initial server render and on live SSE updates.

## What to implement
1. Extend the board ticket model with a \`stageChangedAt\` timestamp.
2. Server render (\`getProjectBoard\` / project page): populate \`stageChangedAt\` from the ticket \`updatedAt\` (the transition to Done is the last write on the entry).
3. LiveBoard: when a ticket moves via SSE, set \`stageChangedAt\` to the event time.
4. When grouping, sort the \`done\` column by \`stageChangedAt\` descending; other columns keep \`sort_order\`.
5. Ensure a live transition into Done places the card on top.

## Out of scope
- Adding a new Aurora schema field (use existing \`updatedAt\` / event time).
- Changing ordering of non-Done columns.

## Acceptance criteria
- On load, Done shows the most recently completed ticket first.
- Completing a ticket live puts its card at the top of Done without refresh.
- Non-Done columns are unchanged.`;

await ensureTicket(
  "fix-traceai-mcp-404-stale-process",
  "Fix stale TraceAI MCP 404 and document reload recovery",
  mcpDesc,
  "high",
);
await ensureTicket(
  "verify-live-board-sse-through-api",
  "Verify live board SSE works through the TraceAI API",
  sseDesc,
  "medium",
);
await ensureTicket(
  "sort-done-lane-by-completion-time",
  "Sort Done lane by completion time (newest on top)",
  doneSortDesc,
  "medium",
);

for (const slug of [
  "fix-traceai-mcp-404-stale-process",
  "verify-live-board-sse-through-api",
  "sort-done-lane-by-completion-time",
]) {
  await transition(
    slug,
    "todo",
    `## Vorige stap
Ticket aangemaakt in **backlog** met volledige, zelfstandige beschrijving.

## Deze stap
Naar **todo**: scope en acceptatiecriteria zijn duidelijk; klaar om op te pakken.`,
  );
  await transition(
    slug,
    "in_progress",
    `## Vorige stap
Ticket stond in **todo**.

## Deze stap
Implementatie/onderzoek gestart in deze sessie. Zie volgende comments voor uitgevoerde acties.`,
  );
}

console.log("WORK_TICKETS_READY");
