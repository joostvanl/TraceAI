#!/usr/bin/env node
/**
 * Idempotent backfill of ticket_key / ticket_number for existing tickets.
 *
 * Usage:
 *   pnpm --filter @traceai/api backfill-ticket-keys
 *   pnpm --filter @traceai/api backfill-ticket-keys -- --project traceai
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

const result = await service.backfillTicketKeys(project);
console.log(
  JSON.stringify(
    {
      updated: result.updated,
      projects: result.projects,
      projectFilter: project ?? null,
    },
    null,
    2,
  ),
);
