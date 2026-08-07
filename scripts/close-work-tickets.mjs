import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const token = readFileSync(resolve("data/bootstrap-token.txt"), "utf8")
  .split(/\r?\n/)
  .find((l) => l.startsWith("token="))
  ?.slice("token=".length)
  .trim();

const api = "http://127.0.0.1:3847";
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function get(slug) {
  const res = await fetch(`${api}/v1/tickets/${slug}`, { headers });
  return res.json();
}
async function transition(slug, to, comment) {
  const res = await fetch(`${api}/v1/tickets/${slug}/transition`, {
    method: "POST",
    headers,
    body: JSON.stringify({ to_stage: to, comment }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${slug} -> ${to}: ${JSON.stringify(body)}`);
  console.log(slug, "->", to);
  return body;
}

const reviewComment = (slug, testverslag) => `## Vorige stap
Implementatie voor ${slug} afgerond in in_progress.

## Deze stap
Naar **review** met testverslag.

## Testverslag
${testverslag}

## Uitslag
PASS`;

const doneComment = (slug) => `## Vorige stap
${slug} stond in **review** met een geslaagd testverslag.

## Deze stap
Naar **done**: acceptatiecriteria voldaan.`;

async function toReviewIfNeeded(slug, testverslag) {
  const t = await get(slug);
  if (t.stage === "in_progress") {
    await transition(slug, "review", reviewComment(slug, testverslag));
  }
}

// Order of completion determines Done ordering (last = top).
await toReviewIfNeeded(
  "fix-traceai-mcp-404-stale-process",
  `- Diagnostic script: health/me/projects/project-traceai met MCP-token — allemaal 200 (scripts/diag-mcp-token.mjs)
- packages/mcp herbouwd; fail() geeft nu een reload-hint bij 404
- README/docs + Cursor-rule beschrijven "MCP 404 → reload MCP, niet Aurora-direct"`,
);
await transition(
  "fix-traceai-mcp-404-stale-process",
  "done",
  doneComment("fix-traceai-mcp-404-stale-process"),
);

await transition(
  "verify-live-board-sse-through-api",
  "done",
  doneComment("verify-live-board-sse-through-api"),
);

await toReviewIfNeeded(
  "sort-done-lane-by-completion-time",
  `- LiveBoard: BoardTicket.stageChangedAt toegevoegd; done-kolom gesorteerd desc
- Server render: stageChangedAt = ticket.updatedAt
- SSE: transitie zet stageChangedAt = event.at (nieuw afgerond ticket bovenop)
- pnpm --filter @traceai/web build — PASS; geen lint errors`,
);
await transition(
  "sort-done-lane-by-completion-time",
  "done",
  doneComment("sort-done-lane-by-completion-time"),
);

console.log("ALL_DONE");
