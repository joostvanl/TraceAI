/**
 * Refine backlog tickets on the public TraceAI API (playbook description + todo).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const mcp = JSON.parse(
  readFileSync(join(homedir(), ".cursor", "mcp.json"), "utf8").replace(/^\uFEFF/, ""),
);
const api = String(mcp.mcpServers.traceai.env.TRACEAI_API_URL).replace(/\/$/, "");
const token = mcp.mcpServers.traceai.env.TRACEAI_TOKEN;

async function apiJson(path, init = {}) {
  const res = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

const backlog = await apiJson("/v1/tickets?project=traceai&stage=backlog");
const tickets = Array.isArray(backlog) ? backlog : backlog?.items ?? backlog?.result ?? [];
console.log(`Backlog count: ${tickets.length}`);
console.log(`API: ${api}`);

const refinedLogin = `## Context

De TraceAI-web-UI heeft nu een **New ticket**-formulier beveiligd met een gedeeld \`TRACEAI_CREATE_SECRET\`. Dat werkt als MVP, maar is geen onderhoudbare authenticatie: één gedeeld wachtwoord voor iedereen die mag aanmaken, zichtbaar in env-bestanden, en geen echte gebruikersidentiteit op writes (\`created_by\` komt van de server-side TraceAI-token).

De wens is een echte loginpagina zodat create (en later andere writes) aan een ingelogde gebruiker hangen, en \`TRACEAI_CREATE_SECRET\` kan verdwijnen.

Bestaande bouwstenen:
- TraceAI API heeft al users + \`trc_…\` tokens (\`packages/auth\`, bootstrap/create-token).
- Web create-proxy: \`apps/web/src/app/api/tickets/route.ts\` (secret-check + server token).
- Board/UI: \`CreateTicketForm.tsx\` op \`/projects/[slug]\`.

## Goal

Voeg een eenvoudige loginpagina toe aan de TraceAI-web-UI met één vaste username/password-combinatie (config via env), zodat na login het create-formulier geen create-secret meer vraagt. Aurora-CMS-login is expliciet **V2 / out of scope**.

## What to implement

1. **Login UI** — pagina \`/login\` met username + password; na succes een HttpOnly session-cookie zetten.
2. **Server auth** — env-vars bv. \`TRACEAI_UI_USER\` + \`TRACEAI_UI_PASSWORD\`; verifieer timing-safe; geen secret meer in het create-formulier.
3. **Protect writes** — \`POST /api/tickets\` vereist geldige session i.p.v. \`TRACEAI_CREATE_SECRET\`; unauthenticated → 401. Bij 401 vanuit het formulier naar \`/login\` sturen.
4. **CreateTicketForm** — verwijder het secret-veld; toon login-state / logout.
5. **Logout** — route die de session wist.
6. **Deploy/env** — documenteer UI-login env in \`deploy/.env.example\` + \`deploy-traceai.sh\`; \`TRACEAI_CREATE_SECRET\` niet meer nodig voor het normale create-pad.
7. **Pi-deploy** na merge zodat het publieke board de login gebruikt.

## Out of scope

- Aurora CMS als identity provider (V2).
- Volledige TraceAI user/token self-service in de browser.
- Transitions/comments vanuit de UI.
- OAuth / SSO / multi-user directory.

## Acceptance criteria

- Zonder login faalt \`POST /api/tickets\` met 401; er wordt geen ticket aangemaakt.
- Na login met de geconfigureerde username/password kan een gebruiker een backlog-ticket aanmaken zonder create-secret-veld.
- Session is HttpOnly en logout beeindigt create-rechten.
- \`TRACEAI_CREATE_SECRET\` is niet meer nodig voor het normale create-pad.
- Publiek board na deploy toont login i.p.v. secret-veld.
`;

for (const t of tickets) {
  const full = await apiJson(`/v1/tickets/${encodeURIComponent(t.slug)}`);
  console.log(`\nRefining ${t.slug}…`);
  console.log(`  wish: ${String(full.description ?? "").slice(0, 100)}…`);

  if (t.slug === "algemene-login-maken") {
    await apiJson(`/v1/tickets/${encodeURIComponent(t.slug)}`, {
      method: "PATCH",
      body: JSON.stringify({ description: refinedLogin }),
    });
    await apiJson(`/v1/tickets/${encodeURIComponent(t.slug)}/transition`, {
      method: "POST",
      body: JSON.stringify({
        to_stage: "todo",
        comment: `## Vorige stap

Ticket stond in Backlog als lichte wens: algemene login zodat TRACEAI_CREATE_SECRET weg kan, eerst met vaste username/password, later Aurora (V2).

## Deze stap

Beschrijving is gerefined tot een uitvoerbaar playbook (Context/Goal/What to implement/Out of scope/Acceptance criteria). Klaar om op te pakken in To do. Aurora-login blijft bewust V2.`,
      }),
    });
    console.log(`  → todo`);
  } else {
    console.log(`  skipped (no refine template for this slug)`);
  }
}

console.log("\nDone.");
