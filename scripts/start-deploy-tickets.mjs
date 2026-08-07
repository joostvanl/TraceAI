import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const token = readFileSync(resolve("data/bootstrap-token.txt"), "utf8")
  .split(/\r?\n/)
  .find((l) => l.startsWith("token="))
  ?.slice("token=".length)
  .trim();
const api = "https://traceai.joostvanleeuwaarden.com";
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function transition(slug, to, comment) {
  const res = await fetch(`${api}/v1/tickets/${slug}/transition`, {
    method: "POST",
    headers,
    body: JSON.stringify({ to_stage: to, comment }),
  });
  const data = await res.json();
  console.log(slug, res.status, data.stage ?? data.message);
}

for (const slug of [
  "push-traceai-sources-to-github",
  "deploy-traceai-docker-raspberry-pi",
]) {
  await transition(
    slug,
    "in_progress",
    `## Vorige stap
Ticket stond in **todo** na aanmaken.

## Deze stap
Start uitvoering: GitHub push + Docker/Pi-deploy in deze sessie.`,
  );
}
