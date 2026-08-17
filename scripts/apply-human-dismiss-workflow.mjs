/**
 * After deploying TraceAI API/web with human_dismiss_to + dismissed verdict support,
 * apply the Product Development gate outcomes that production previously stripped.
 *
 * Usage (with TRACEAI_TOKEN):
 *   node scripts/apply-human-dismiss-workflow.mjs
 */

const apiBase =
  process.env.TRACEAI_API_BASE?.replace(/\/$/, "") ||
  "https://traceai.joostvanleeuwaarden.com";
const token = process.env.TRACEAI_TOKEN;
if (!token) {
  console.error("TRACEAI_TOKEN required");
  process.exit(1);
}

const workflowSlug = process.env.TRACEAI_WORKFLOW || "traceai-product-development";

const res = await fetch(`${apiBase}/v1/workflows/${encodeURIComponent(workflowSlug)}`, {
  headers: { Authorization: `Bearer ${token}` },
});
if (!res.ok) {
  console.error("get workflow failed", res.status, await res.text());
  process.exit(1);
}
const current = await res.json();
const doc = current.workflow_document ?? {
  version: 3,
  agent_policy: current.agent_policy,
  stages: current.stages,
};

for (const stage of doc.stages ?? []) {
  if (stage.key === "in_refinement") {
    stage.transitions = ["todo", "backlog", "done"];
    stage.agent = {
      ...stage.agent,
      require_human_approval_on_exit: true,
      human_approve_to: "todo",
      human_reject_to: ["backlog"],
      human_dismiss_to: "done",
    };
  }
  if (stage.key === "todo") {
    stage.transitions = ["in_progress", "backlog", "in_refinement", "done"];
    stage.agent = {
      ...stage.agent,
      require_human_approval_on_exit: true,
      human_approve_to: "in_progress",
      human_reject_to: [],
      human_dismiss_to: "done",
      purpose:
        "Human intake gate: approve to start implementation, or dismiss to close without picking the work up. No reject — there is no proposal to send back for rework.",
      on_exit: [
        "Wait for the human intake verdict; only then transition.",
        "When approved, describe the first implementation step and confirm work can start (→ In progress).",
        "When dismissed, move to Done with ## Reden, an appropriate non-completed resolution, and ## Wiki.",
      ],
    };
  }
  if (stage.key === "review" && stage.agent) {
    delete stage.agent.human_dismiss_to;
  }
}

const put = await fetch(`${apiBase}/v1/workflows/${encodeURIComponent(workflowSlug)}`, {
  method: "PATCH",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ document: doc }),
});
const body = await put.text();
if (!put.ok) {
  console.error("update failed", put.status, body);
  process.exit(1);
}
console.log("applied human_dismiss_to on", workflowSlug);
const check = JSON.parse(body);
const refine = (check.stages ?? []).find((s) => s.key === "in_refinement");
const todo = (check.stages ?? []).find((s) => s.key === "todo");
console.log("in_refinement.human_dismiss_to", refine?.agent?.human_dismiss_to);
console.log("todo.human_dismiss_to", todo?.agent?.human_dismiss_to);
console.log("todo.require_human_approval_on_exit", todo?.agent?.require_human_approval_on_exit);
