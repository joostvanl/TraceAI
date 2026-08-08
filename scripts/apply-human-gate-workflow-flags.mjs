#!/usr/bin/env node
/**
 * Re-apply TRA-32 human-gate flags on live workflows after deploying an API
 * that understands require_human_approval_on_exit (older parsers strip them
 * from get_workflow responses even when stages_json already contains them).
 *
 * Usage (from repo root, with TRACEAI_TOKEN + TRACEAI_API_URL):
 *   node scripts/apply-human-gate-workflow-flags.mjs
 */
import { TraceApiClient } from "@traceai/core";

const WORKFLOWS = [
  "traceai-product-development",
  "traceai-default",
  "demo-default",
];

function patchStages(stages) {
  return stages.map((stage) => {
    if (stage.key !== "review") return stage;
    return {
      ...stage,
      agent: {
        ...(stage.agent ?? {}),
        require_human_approval_on_exit: true,
        human_approve_to: stage.agent?.human_approve_to ?? "done",
        human_reject_to: stage.agent?.human_reject_to ?? ["in_progress"],
      },
    };
  });
}

async function main() {
  const apiUrl = process.env.TRACEAI_API_URL?.replace(/\/$/, "");
  const token = process.env.TRACEAI_TOKEN;
  if (!apiUrl || !token?.startsWith("trc_")) {
    throw new Error("Set TRACEAI_API_URL and TRACEAI_TOKEN (trc_…)");
  }
  const client = new TraceApiClient({ apiUrl, token });

  for (const slug of WORKFLOWS) {
    const wf = /** @type {any} */ (await client.getWorkflow(slug));
    const doc = wf.workflow_document ?? {
      version: 3,
      agent_policy: wf.agent_policy,
      stages: wf.stages,
    };
    const stages = patchStages(doc.stages ?? wf.stages ?? []);
    await client.updateWorkflow(slug, {
      document: {
        version: doc.version ?? 3,
        agent_policy: doc.agent_policy ?? wf.agent_policy,
        stages,
      },
    });
    const verify = /** @type {any} */ (await client.getWorkflow(slug));
    const review = (verify.stages ?? []).find((s) => s.key === "review");
    console.log(
      slug,
      "review.require_human_approval_on_exit=",
      review?.agent?.require_human_approval_on_exit ?? false,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
