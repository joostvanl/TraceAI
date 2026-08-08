/**
 * Merge LLM token playbook flags into existing Aurora workflows via TraceAI API.
 * Does not print secrets.
 *
 *   TRACEAI_TOKEN=trc_… node scripts/apply-token-workflow-flags.mjs
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
  throw new Error("Set TRACEAI_TOKEN or provide data/bootstrap-token.txt");
}

function withTokenFlags(doc) {
  const policy = { ...(doc.agent_policy ?? {}) };
  policy.summary =
    "TraceAI tickets must be self-contained for junior agents. Every workflow transition needs a Markdown comment describing completed work, plus tokens_used (self-reported LLM token delta for that step). Entering review always requires a short test report with results.";
  const every = Array.isArray(policy.on_every_transition)
    ? [...policy.on_every_transition]
    : [];
  const usedHint =
    "Pass tokens_used: a non-negative integer estimate of LLM tokens (prompt+completion) spent on this step.";
  if (!every.some((line) => String(line).includes("tokens_used"))) {
    every.push(usedHint);
  }
  policy.on_every_transition = every;
  policy.require_tokens_used_on_transition = true;

  const stages = (doc.stages ?? []).map((stage) => {
    if (stage.key !== "backlog") return stage;
    const agent = { ...(stage.agent ?? {}) };
    const onExit = Array.isArray(agent.on_exit) ? [...agent.on_exit] : [];
    const estimateHint =
      "Pass tokens_estimate: your LLM token estimate for the whole ticket.";
    if (!onExit.some((line) => String(line).includes("tokens_estimate"))) {
      onExit.push(estimateHint);
    }
    agent.on_exit = onExit;
    agent.require_tokens_estimate_on_exit = true;
    return { ...stage, agent };
  });

  return {
    version: doc.version ?? 2,
    agent_policy: policy,
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
  const doc = withTokenFlags(
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
  const backlog = verify.stages?.find((s) => s.key === "backlog");
  updated.push({
    slug: row.slug,
    require_tokens_used_on_transition:
      verify.agent_policy?.require_tokens_used_on_transition === true,
    require_tokens_estimate_on_exit:
      backlog?.agent?.require_tokens_estimate_on_exit === true,
  });
}

console.log(JSON.stringify({ apiUrl, updated }, null, 2));
