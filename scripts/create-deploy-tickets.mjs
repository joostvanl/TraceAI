import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const token = readFileSync(resolve("data/bootstrap-token.txt"), "utf8")
  .split(/\r?\n/)
  .find((l) => l.startsWith("token="))
  ?.slice("token=".length)
  .trim();
if (!token) process.exit(1);

const api = process.env.TRACEAI_API_URL ?? "https://traceai.joostvanleeuwaarden.com";
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

async function req(path, init) {
  const res = await fetch(`${api}${path}`, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function ensureTicket(slug, title, description, priority = "high") {
  try {
    const t = await req("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        project: "traceai",
        slug,
        title,
        description,
        priority,
        stage: "in_progress",
      }),
    });
    console.log("created", t.slug, t.stage);
    return t;
  } catch (e) {
    console.log("create", slug, String(e).slice(0, 180));
    return { slug };
  }
}

async function transition(slug, to, comment) {
  const res = await fetch(`${api}/v1/tickets/${slug}/transition`, {
    method: "POST",
    headers,
    body: JSON.stringify({ to_stage: to, comment }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${slug}->${to} ${res.status} ${JSON.stringify(data)}`);
  console.log(slug, "->", to);
}

const githubDesc = `## Context
TraceAI leeft alleen lokaal onder \`webroot/TraceAI\` en is nog geen git-repo. Target remote: https://github.com/joostvanl/TraceAI. Secrets (\\\`.env\\\`, tokens, SQLite auth DB) mogen nooit in git.

## Goal
Volledige TraceAI monorepo naar GitHub pushen zodat de Raspberry Pi vanaf daar kan clonen/deployen.

## What to implement
1. \`.gitignore\` controleren (node_modules, .env*, data/, dist, .next, sqlite).
2. \`git init\` + initial commit van sources.
3. GitHub-repo \`joostvanl/TraceAI\` aanmaken of gebruiken.
4. Remote \`origin\` toevoegen en \`main\` pushen.
5. Bevestigen dat apps/, packages/, docs/, scripts/ remote staan zonder secrets.

## Out of scope
- Pi Docker-deploy (apart ticket).

## Acceptance criteria
- https://github.com/joostvanl/TraceAI bevat de monorepo.
- Geen tokens/\\\`.env\\\`/\`data/*.sqlite\` in de commit.
- Remote is bereikbaar voor clone op de Pi.
`;

const dockerDesc = `## Context
TraceAI (API + read-only web UI) moet op Raspberry Pi 5 (\`192.168.1.91\`, user \`joostvl\`) draaien. De UI (TraceUI/web) moet in Docker. Zelfde Aurora CMS-website/project mag blijven (\`websiteId\` / site key zoals lokaal).

## Goal
Docker images + compose voor TraceAI API en web op linux/arm64, deployen op de Pi, UI bereikbaar vanaf het LAN; live board via SSE op de Pi-API.

## What to implement
1. Dockerfiles voor \`apps/api\` en \`apps/web\` (multi-stage, pnpm workspace-aware, arm64).
2. \`docker-compose.yml\` (+ \`.env.example\` voor Pi) met volumes voor auth SQLite, env voor Aurora + public site key + events URL.
3. Deploy-docs / script: clone van GitHub op de Pi, env invullen, \`docker compose up -d\`.
4. SSH naar \`joostvl@192.168.1.91\`, repo clonen, containers starten.
5. Verifieer: web UI laadt projectboard; \`/health\` op API; zelfde Aurora-project zichtbaar.

## Out of scope
- MCP op de Pi (agents blijven lokaal of wijzen later naar Pi-API).
- Nieuw Aurora-project.

## Acceptance criteria
- \`docker compose ps\` op de Pi toont healthy/running web (+ API).
- Browser/LAN kan de TraceAI UI openen.
- Board toont tickets uit het bestaande Aurora TraceAI-project.
- Done-lane en live SSE werken tegen de Pi-API events URL.
`;

await ensureTicket(
  "push-traceai-sources-to-github",
  "Push TraceAI sources to GitHub (joostvanl/TraceAI)",
  githubDesc,
);
await ensureTicket(
  "deploy-traceai-docker-raspberry-pi",
  "Deploy TraceAI (UI+API) with Docker on Raspberry Pi 5",
  dockerDesc,
);

for (const slug of [
  "push-traceai-sources-to-github",
  "deploy-traceai-docker-raspberry-pi",
]) {
  // already created in in_progress if API accepts stage; ensure comment trail
  try {
    await transition(
      slug,
      "todo",
      `## Vorige stap
Ticket aangemaakt.

## Deze stap
Naar todo zodat de workflow-transitie start (indien nog in backlog).`,
    );
  } catch {
    /* may already be past todo */
  }
}

console.log("TICKETS_READY");
