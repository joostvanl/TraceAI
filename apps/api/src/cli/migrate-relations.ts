#!/usr/bin/env node
/**
 * TRA-50: re-bind Aurora relation FKs that were converted from text slugs.
 *
 * Idempotent: reads current slug values, verifies targets exist, re-writes
 * the same slug into the relation field (or reports orphans).
 *
 *   pnpm --filter @traceai/api migrate-relations
 *   pnpm --filter @traceai/api migrate-relations -- --dry-run
 */
import {
  isProjectRole,
  listAllEntries,
  relationSlug,
  WIKI_PAGE_CONTENT_TYPE,
  type Ticket,
  type WikiPage,
} from "@traceai/core";
import { createTraceService, loadEnv } from "../env.js";

const dryRun = process.argv.includes("--dry-run");
const env = loadEnv();
const service = createTraceService(env);
await service.ensureReady();

type Counts = { checked: number; rewritten: number; orphans: number };
const summary: Record<string, Counts> = {
  memberships: { checked: 0, rewritten: 0, orphans: 0 },
  tickets: { checked: 0, rewritten: 0, orphans: 0 },
  wiki: { checked: 0, rewritten: 0, orphans: 0 },
};

const client = service.client;

console.log(dryRun ? "Dry run — no writes" : "Migrating relation bindings…");

const memberships = await service.listProjectMemberships();
for (const m of memberships) {
  summary.memberships.checked += 1;
  const project = relationSlug(m.fields.project);
  const user = relationSlug(m.fields.user);
  const role = m.fields.role;
  if (!project || !user || !isProjectRole(role)) {
    summary.memberships.orphans += 1;
    console.warn(
      `ORPHAN membership ${m.slug}: project=${project} user=${user} role=${role}`,
    );
    continue;
  }
  const projectOk = await client.getEntryBySlug("project", project);
  const userOk = await service.getTraceaiUser(user);
  if (!projectOk || !userOk) {
    summary.memberships.orphans += 1;
    console.warn(
      `ORPHAN membership ${m.slug}: missing ${!projectOk ? `project:${project}` : ""} ${!userOk ? `user:${user}` : ""}`.trim(),
    );
    continue;
  }
  if (dryRun) {
    console.log(`OK membership ${m.slug} → ${project}/${user}/${role}`);
    continue;
  }
  await service.setProjectMembership({ project, user, role });
  summary.memberships.rewritten += 1;
}

const tickets = await listAllEntries<Ticket>(client, "ticket", {
  status: "published",
});
for (const t of tickets) {
  summary.tickets.checked += 1;
  const project = relationSlug(t.fields.project);
  const workflow = relationSlug(t.fields.workflow);
  const parent = relationSlug(t.fields.parent);
  if (!project || !workflow) {
    summary.tickets.orphans += 1;
    console.warn(
      `ORPHAN ticket ${t.slug}: project=${project} workflow=${workflow}`,
    );
    continue;
  }
  if (parent) {
    const parentEntry = await client.getEntryBySlug<Ticket>("ticket", parent);
    if (!parentEntry) {
      summary.tickets.orphans += 1;
      console.warn(`ORPHAN ticket ${t.slug}: parent missing ${parent}`);
      continue;
    }
  }
  if (dryRun) {
    console.log(`OK ticket ${t.slug} parent=${parent ?? "(none)"}`);
    continue;
  }
  await client.updateEntry("ticket", t.id, {
    fields: {
      project,
      workflow,
      ...(parent ? { parent } : { parent: null }),
    },
  });
  await client.publishEntry("ticket", t.id);
  summary.tickets.rewritten += 1;
}

const wiki = await listAllEntries<WikiPage>(client, WIKI_PAGE_CONTENT_TYPE, {
  status: "published",
});
for (const p of wiki) {
  summary.wiki.checked += 1;
  const project = relationSlug(p.fields.project);
  const parent = relationSlug(p.fields.parent);
  if (!project) {
    summary.wiki.orphans += 1;
    console.warn(`ORPHAN wiki ${p.slug}: missing project`);
    continue;
  }
  const projectOk = await client.getEntryBySlug("project", project);
  if (!projectOk) {
    summary.wiki.orphans += 1;
    console.warn(`ORPHAN wiki ${p.slug}: project missing ${project}`);
    continue;
  }
  if (parent) {
    const parentOk = await client.getEntryBySlug(WIKI_PAGE_CONTENT_TYPE, parent);
    if (!parentOk) {
      summary.wiki.orphans += 1;
      console.warn(`ORPHAN wiki ${p.slug}: parent missing ${parent}`);
      continue;
    }
  }
  if (dryRun) {
    console.log(
      `OK wiki ${p.slug} project=${project} parent=${parent ?? "(none)"}`,
    );
    continue;
  }
  await client.updateEntry(WIKI_PAGE_CONTENT_TYPE, p.id, {
    fields: {
      project,
      ...(parent ? { parent } : { parent: null }),
    },
  });
  await client.publishEntry(WIKI_PAGE_CONTENT_TYPE, p.id);
  summary.wiki.rewritten += 1;
}

console.log("\nSummary:");
for (const [key, counts] of Object.entries(summary)) {
  console.log(
    `  ${key}: checked=${counts.checked} rewritten=${counts.rewritten} orphans=${counts.orphans}`,
  );
}

if (
  summary.memberships.orphans ||
  summary.tickets.orphans ||
  summary.wiki.orphans
) {
  process.exitCode = 2;
}
