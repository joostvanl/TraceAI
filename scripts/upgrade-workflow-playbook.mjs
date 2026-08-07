#!/usr/bin/env node
/**
 * Upgrade workflows to v2 document with agent_policy + stage agent rules.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_WORKFLOW_DOCUMENT } from "../packages/core/dist/index.js";

const token = readFileSync(resolve("data/bootstrap-token.txt"), "utf8")
  .split(/\r?\n/)
  .find((l) => l.startsWith("token="))
  ?.slice("token=".length)
  .trim();
if (!token) {
  console.error("Missing bootstrap token");
  process.exit(1);
}

const api = process.env.TRACEAI_API_URL ?? "http://127.0.0.1:3847";
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

async function apiJson(path, init) {
  const res = await fetch(`${api}${path}`, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const description = `## Context
Agents (including juniors with no chat history) must always know TraceAI working agreements: rich ticket descriptions, mandatory transition comments, and a test report when entering review.

## Goal
Encode those agreements in workflow \`stages_json\` as \`agent_policy\` + per-stage \`agent\` rules, return them from \`get_project\` / \`get_workflow\`, and enforce them in the API/MCP.

## What to implement
1. Extend workflow JSON schema to version 2 document (\`agent_policy\` + \`stages[].agent\`).
2. Keep backward compatibility with legacy stage arrays (defaults fill missing agent rules).
3. Validate ticket descriptions on create/update.
4. Require \`comment\` on every transition; require \`## Testverslag\` + \`## Uitslag\` when entering review.
5. Surface playbook in MCP tool descriptions and \`get_project.agent_playbook\`.
6. Upgrade existing workflows (\`traceai-product-development\`, \`demo-default\`).
7. Document in \`docs/agent-playbook.md\`, homepage rules, and \`.cursor/rules/traceai-agent.mdc\`.

## Out of scope
- Changing Aurora schema field types
- Human UI editing of policy (agents/API only for now)

## Acceptance criteria
- \`get_project\` / \`get_workflow\` return \`agent_policy\` and stage \`agent\` instructions.
- Creating a ticket with a one-line description fails validation.
- Transition without comment fails.
- Transition into review without test report headings fails.
- Existing TraceAI workflows store the v2 document.
`;

let ticket;
try {
  ticket = await apiJson("/v1/tickets", {
    method: "POST",
    body: JSON.stringify({
      project: "traceai",
      slug: "workflow-agent-playbook-enforcement",
      title: "Embed agent playbook in workflow JSON and enforce on API/MCP",
      priority: "high",
      stage: "in_progress",
      description,
    }),
  });
  console.log("ticket created", ticket.slug);
} catch (error) {
  console.log("ticket create skipped/failed:", String(error));
  ticket = { slug: "workflow-agent-playbook-enforcement" };
}

for (const slug of ["traceai-product-development", "demo-default"]) {
  const updated = await apiJson(`/v1/workflows/${slug}`, {
    method: "PATCH",
    body: JSON.stringify({
      document: DEFAULT_WORKFLOW_DOCUMENT,
    }),
  });
  console.log(
    "upgraded",
    slug,
    "version",
    updated.workflow_document?.version,
    "policy summary chars",
    updated.agent_policy?.summary?.length ?? 0,
  );
}

console.log("DONE", ticket.slug);
