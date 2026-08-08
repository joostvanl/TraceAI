/**
 * Merge wiki DoD (## Wiki on enter done) into existing Aurora workflows via TraceAI API.
 *
 *   TRACEAI_TOKEN=trc_… node scripts/apply-wiki-workflow-flags.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadToken() {
  if (process.env.TRACEAI_TOKEN?.startsWith("trc_")) {
    return process.env.TRACEAI_TOKEN;
  }
  for (const path of [
    resolve("apps/web/.env.local"),
    resolve("data/bootstrap-token.txt"),
  ]) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const envMatch = text.match(/^TRACEAI_TOKEN=(trc_[A-Za-z0-9_-]+)/m);
    if (envMatch) return envMatch[1];
    const raw = text.match(/trc_[A-Za-z0-9_-]+/);
    if (raw) return raw[0];
  }
  throw new Error("Set TRACEAI_TOKEN or provide apps/web/.env.local");
}

const WIKI_HINT =
  "Include ## Wiki with the TraceAI wiki page slug(s) you created/updated for this ticket (Cursor → TraceAI MCP only).";

function withWikiFlags(doc) {
  const stages = (doc.stages ?? []).map((stage) => {
    if (stage.key !== "done") {
      if (stage.key !== "review") return stage;
      const agent = { ...(stage.agent ?? {}) };
      const onExit = Array.isArray(agent.on_exit) ? [...agent.on_exit] : [];
      const hint =
        "If moving to Done, confirm acceptance criteria are met and document the outcome in the project wiki via TraceAI MCP (include ## Wiki when entering Done).";
      if (!onExit.some((line) => String(line).includes("## Wiki"))) {
        onExit.push(hint);
      }
      agent.on_exit = onExit;
      return { ...stage, agent };
    }
    const agent = { ...(stage.agent ?? {}) };
    const onEnter = Array.isArray(agent.on_enter) ? [...agent.on_enter] : [];
    if (!onEnter.some((line) => String(line).includes("## Wiki"))) {
      onEnter.push(WIKI_HINT);
    }
    agent.on_enter = onEnter;
    const sections = Array.isArray(agent.require_comment_sections_on_enter)
      ? [...agent.require_comment_sections_on_enter]
      : [];
    if (!sections.some((s) => String(s).toLowerCase() === "## wiki")) {
      sections.push("## Wiki");
    }
    agent.require_comment_sections_on_enter = sections;
    agent.require_comment_on_enter = true;
    return { ...stage, agent };
  });

  return {
    version: doc.version ?? 2,
    agent_policy: doc.agent_policy ?? {},
    stages,
  };
}

const apiUrl = (
  process.env.TRACEAI_API_URL ?? "https://traceai.joostvanleeuwaarden.com"
).replace(/\/$/, "");
const token = loadToken();

async function api(path, init = {}) {
  const res = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

const workflows = await api("/v1/workflows");
const updated = [];

for (const row of workflows) {
  const current = await api(`/v1/workflows/${encodeURIComponent(row.slug)}`);
  const doc = withWikiFlags(
    current.workflow_document ?? {
      version: 2,
      agent_policy: current.agent_policy,
      stages: current.stages,
    },
  );
  await api(`/v1/workflows/${encodeURIComponent(row.slug)}`, {
    method: "PATCH",
    body: JSON.stringify({ document: doc }),
  });
  const verify = await api(`/v1/workflows/${encodeURIComponent(row.slug)}`);
  const done = verify.stages?.find((s) => s.key === "done");
  updated.push({
    slug: row.slug,
    require_wiki_on_done: (
      done?.agent?.require_comment_sections_on_enter ?? []
    ).some((s) => String(s).toLowerCase() === "## wiki"),
  });
}

console.log(JSON.stringify({ apiUrl, updated }, null, 2));
