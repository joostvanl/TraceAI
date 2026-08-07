#!/usr/bin/env node
/**
 * Backfill stage_entered_at and archive overflow in each workflow's last stage
 * (keep newest LAST_STAGE_VISIBLE_LIMIT visible).
 *
 * Usage:
 *   pnpm --filter @traceai/api backfill-last-stage-archive
 *   pnpm --filter @traceai/api backfill-last-stage-archive -- --project traceai
 */
import { createTraceService, loadEnv } from "../env.js";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

const env = loadEnv();
const service = createTraceService(env);
const project = arg("project");

const result = await service.backfillLastStageArchive(project);
console.log(
  JSON.stringify(
    {
      stageEnteredBackfilled: result.stageEnteredBackfilled,
      archived: result.archived,
      projects: result.projects,
      projectFilter: project ?? null,
    },
    null,
    2,
  ),
);
