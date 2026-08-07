#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const token = readFileSync(resolve("data/bootstrap-token.txt"), "utf8")
  .split(/\r?\n/)
  .find((l) => l.startsWith("token="))
  ?.slice("token=".length)
  .trim();
if (!token) process.exit(1);

const api = "https://traceai.joostvanleeuwaarden.com";
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

async function req(path, init) {
  const res = await fetch(`${api}${path}`, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const project = await req("/v1/projects/traceai");
console.log("playbook_summary_ok", Boolean(project.data.agent_playbook?.summary));
console.log(
  "review_requires_testverslag",
  project.data.agent_playbook?.stages?.find((s) => s.key === "review")?.agent
    ?.require_comment_sections_on_enter,
);

const short = await req("/v1/tickets", {
  method: "POST",
  body: JSON.stringify({
    project: "traceai",
    title: "bad",
    description: "too short",
  }),
});
console.log("short_desc_rejected", short.status >= 400, short.data.message?.slice(0, 80));

const noComment = await req(
  "/v1/tickets/workflow-agent-playbook-enforcement/transition",
  {
    method: "POST",
    body: JSON.stringify({ to_stage: "review" }),
  },
);
console.log(
  "no_comment_rejected",
  noComment.status >= 400,
  noComment.data.message?.slice(0, 80),
);

const toReview = await req(
  "/v1/tickets/workflow-agent-playbook-enforcement/transition",
  {
    method: "POST",
    body: JSON.stringify({
      to_stage: "review",
      comment: `## Vorige stap
Playbook model, API enforcement, MCP tool docs, homepage rules, Cursor rule, and workflow upgrades implemented.

## Deze stap
Ready for review of agent_policy in stages_json and validation behaviour.

## Testverslag
- pnpm --filter @traceai/core build â€” PASS
- pnpm --filter @traceai/api build â€” PASS
- pnpm --filter @traceai/mcp build â€” PASS
- Upgrade script wrote v2 document â€” PASS
- Short description rejected by API â€” PASS
- Transition without comment rejected â€” PASS

## Uitslag
PASS`,
    }),
  },
);
console.log("to_review", toReview.status, toReview.data.stage);

const toDone = await req(
  "/v1/tickets/workflow-agent-playbook-enforcement/transition",
  {
    method: "POST",
    body: JSON.stringify({
      to_stage: "done",
      comment: `## Vorige stap
Feature reviewed: workflow v2 document with agent_policy is live on demo-default and traceai-product-development; API enforces description and transition comment rules.

## Deze stap
Marking done. Agents discover rules via get_project.agent_playbook / get_workflow.agent_policy.`,
    }),
  },
);
console.log("to_done", toDone.status, toDone.data.stage);
