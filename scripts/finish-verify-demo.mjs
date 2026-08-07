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

const res = await fetch(`${api}/v1/tickets/live-board-verify-demo/transition`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    to_stage: "done",
    comment: `## Vorige stap
Ticket stond in **in_progress** / **review**. SSE endpoint bewezen: \`connected\` + \`ticket.transitioned\` ontvangen op \`/events?project=traceai\` zonder page refresh. API + web herstart op poorten 3847 / 3010. Homepage vermeldt live boards.

## Deze stap
Feature afgerond. Open https://traceai.joostvanleeuwaarden.com/projects/traceai â€” bij MCP/API transitions bewegen kaarten live.`,
  }),
});
console.log(await res.json());
