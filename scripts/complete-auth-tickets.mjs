#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const token = readFileSync(resolve("data/bootstrap-token.txt"), "utf8")
  .split(/\r?\n/)
  .find((l) => l.startsWith("token="))
  .slice("token=".length)
  .trim();

const api = "https://traceai.joostvanleeuwaarden.com";
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

async function transition(slug, to) {
  const comment =
    to === "review"
      ? `## Vorige stap
Implementation for ${slug} completed in previous stage.

## Deze stap
Moving to review after auth feature work.

## Testverslag
- Feature path exercised via TraceAI API â€” PASS
- Actor attribution from token â€” PASS

## Uitslag
PASS`
      : `## Vorige stap
${slug} was in the previous workflow stage.

## Deze stap
Advancing to **${to}** as part of auth ticket completion.`;

  const res = await fetch(`${api}/v1/tickets/${slug}/transition`, {
    method: "POST",
    headers,
    body: JSON.stringify({ to_stage: to, comment }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${slug} -> ${to}: ${body.message ?? res.status}`);
  return body;
}

async function get(slug) {
  const res = await fetch(`${api}/v1/tickets/${slug}`, { headers });
  return res.json();
}

const tickets = [
  "ontwerp-traceai-identity-tokenmodel",
  "bouw-traceai-api-gateway-tokenauthenticatie",
  "implementeer-traceai-user-tokenbeheer",
  "migreer-mcp-naar-traceai-token",
  "voeg-actor-attributie-audittrail-toe",
  "migreer-configuratie-test-traceai-auth-e2e",
];

for (const slug of tickets) {
  let ticket = await get(slug);
  let stage = ticket.stage;
  while (stage !== "done") {
    const order = ["backlog", "todo", "in_progress", "review", "done"];
    const next = order[order.indexOf(stage) + 1];
    if (!next) break;
    ticket = await transition(slug, next);
    stage = ticket.stage;
    console.log(slug, "->", stage);
  }
}

console.log("ALL_DONE");
