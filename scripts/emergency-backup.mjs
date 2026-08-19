// Emergency content backup: pulls every TraceAI content entry out of Aurora and
// writes it to disk. Written during the pi5 storage failure of 2026-08-18, when
// the TraceAI API was already unusable and only Aurora still answered.
//
// Uses the PUBLIC read route with the site key (same path the web UI uses), so
// it needs no management token — the local AURORA_USER_TOKEN had expired.
// Read-only. Paginates at 100 because Aurora caps a page there (TRA-75).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function envFrom(path) {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
  );
}

const web = envFrom("apps/web/.env.local");
const api = envFrom("apps/api/.env");

const API = (web.NEXT_PUBLIC_CMS_API_URL || api.AURORA_API_URL || "").replace(/\/$/, "");
const SITE_KEY = web.CMS_SITE_KEY || web.NEXT_PUBLIC_CMS_SITE_KEY;
const LOCALE = api.AURORA_LOCALE || "en-US";
const OUT = join("backup", "aurora-traceai");

if (!API || !SITE_KEY) throw new Error("missing Aurora API url or site key");
mkdirSync(OUT, { recursive: true });

async function listAll(apiId) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const url = `${API}/api/v1/content-types/${apiId}/entries?locale=${LOCALE}&limit=100&offset=${offset}`;
    const res = await fetch(url, { headers: { "x-site-key": SITE_KEY } });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 160)}`);
    const body = JSON.parse(text);
    const page = body.items ?? [];
    rows.push(...page);
    if (page.length < 100) break;
    offset += 100;
  }
  return rows;
}

const TYPES = [
  "project",
  "ticket",
  "ticket_comment",
  "wiki_page",
  "workflow",
  "project_membership",
  "traceai_user",
];

const summary = [];
for (const type of TYPES) {
  try {
    const rows = await listAll(type);
    writeFileSync(join(OUT, `${type}.json`), JSON.stringify(rows, null, 2), "utf8");
    summary.push(`${type}: ${rows.length} entries`);
  } catch (e) {
    summary.push(`${type}: FAILED ${String(e.message).slice(0, 140)}`);
  }
}
console.log(summary.join("\n"));
