/**
 * Merge require_resolution_on_enter into Done stages of existing Aurora workflows
 * via TraceAI API. Does not print secrets.
 *
 *   TRACEAI_TOKEN=trc_… node scripts/apply-resolution-workflow-flags.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadToken() {
  if (process.env.TRACEAI_TOKEN?.startsWith("trc_")) {
    return process.env.TRACEAI_TOKEN;
  }
  const bootstrap = resolve("data/bootstrap-token.txt");
  if (existsSync(bootstrap)) {
    const text = readFileSync(bootstrap, "utf8");
    const match = text.match(/trc_[A-Za-z0-9_-]+/);
    if (match) return match[0];
  }
  const envLocal = resolve("apps/web/.env.local");
  if (existsSync(envLocal)) {
    const text = readFileSync(envLocal, "utf8");
    const match = text.match(/TRACEAI_TOKEN=(trc_[A-Za-z0-9_-]+)/);
    if (match) return match[1];
  }
  throw new Error("Set TRACEAI_TOKEN or provide data/bootstrap-token.txt");
}

const RESOLUTION_HINT =
  "Pass resolution: completed | superseded | cancelled | duplicate | verification-only (Done ≠ always functionally shipped).";

function withResolutionFlags(doc) {
  const stages = (doc.stages ?? []).map((stage) => {
    if (stage.key !== "done") return stage;
    const agent = { ...(stage.agent ?? {}) };
    const onEnter = Array.isArray(agent.on_enter) ? [...agent.on_enter] : [];
    if (!onEnter.some((line) => String(line).includes("resolution"))) {
      onEnter.push(RESOLUTION_HINT);
    }
    agent.on_enter = onEnter;
    agent.require_resolution_on_enter = true;
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
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${text}`);
  }
  return body;
}

const workflows = await api("/v1/workflows");
const updated = [];

for (const row of workflows) {
  const current = await api(`/v1/workflows/${encodeURIComponent(row.slug)}`);
  const doc = withResolutionFlags(
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
    require_resolution_on_enter:
      done?.agent?.require_resolution_on_enter === true,
  });
}

console.log(JSON.stringify({ apiUrl, updated }, null, 2));
