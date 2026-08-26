import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  AGENT_BUSY_RETRY_MS,
  AGENT_BUSY_RETRY_WINDOW_MS,
  agentBusyRetryDelayMs,
  claimedAgentKind,
  cloudNudgeSkipComment,
  cloudNudgeSkipReason,
  cloudWakeupPrompt,
  normalizeClaimedAgentId,
  type CursorCloudFollowUp,
  type NudgeClaimResult,
  type Ticket,
} from "@traceai/core";

export const NUDGE_QUEUE_LEASE_MS = 25_000;
export const NUDGE_QUEUE_POLL_MS = 1_000;

export type PendingCloudNudge = {
  id: number;
  ticket_slug: string;
  agent_id: string;
  verdict: string;
  stage: string;
  ticket_key: string | null;
  prompt: string;
  first_attempt_at: string;
  next_retry_at: string;
  attempts: number;
  lease_until: string | null;
  last_status: number | null;
};

/**
 * Durable pending Cursor follow-ups after `409 agent_busy`. Sibling SQLite
 * file (not the append-only events DB). One row per ticket slug; last-writer
 * wins on a newer verdict. Lease columns keep two API workers from double-POST.
 */
export class NudgeQueueStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_cloud_nudges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_slug TEXT UNIQUE NOT NULL,
        agent_id TEXT NOT NULL,
        verdict TEXT NOT NULL,
        stage TEXT NOT NULL,
        ticket_key TEXT,
        prompt TEXT NOT NULL,
        first_attempt_at TEXT NOT NULL,
        next_retry_at TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        lease_until TEXT,
        last_status INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_pending_cloud_nudges_due
        ON pending_cloud_nudges(next_retry_at);
    `);
  }

  upsert(
    input: {
      ticket_slug: string;
      agent_id: string;
      verdict: string;
      stage: string;
      ticket_key?: string | null;
      prompt: string;
      first_attempt_at: string;
      next_retry_at: string;
      attempts: number;
      last_status?: number | null;
    },
  ): PendingCloudNudge {
    this.db
      .prepare(
        `INSERT INTO pending_cloud_nudges (
           ticket_slug, agent_id, verdict, stage, ticket_key, prompt,
           first_attempt_at, next_retry_at, attempts, lease_until, last_status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(ticket_slug) DO UPDATE SET
           agent_id = excluded.agent_id,
           verdict = excluded.verdict,
           stage = excluded.stage,
           ticket_key = excluded.ticket_key,
           prompt = excluded.prompt,
           first_attempt_at = excluded.first_attempt_at,
           next_retry_at = excluded.next_retry_at,
           attempts = excluded.attempts,
           lease_until = NULL,
           last_status = excluded.last_status`,
      )
      .run(
        input.ticket_slug,
        input.agent_id,
        input.verdict,
        input.stage,
        input.ticket_key ?? null,
        input.prompt,
        input.first_attempt_at,
        input.next_retry_at,
        input.attempts,
        input.last_status ?? null,
      );
    return this.getBySlug(input.ticket_slug)!;
  }

  getBySlug(slug: string): PendingCloudNudge | null {
    const row = this.db
      .prepare(`SELECT * FROM pending_cloud_nudges WHERE ticket_slug = ?`)
      .get(slug) as Record<string, unknown> | undefined;
    return row ? mapNudgeRow(row) : null;
  }

  listAll(): PendingCloudNudge[] {
    const rows = this.db
      .prepare(`SELECT * FROM pending_cloud_nudges ORDER BY id ASC`)
      .all() as Record<string, unknown>[];
    return rows.map(mapNudgeRow);
  }

  /**
   * Claim due rows whose lease is empty or expired. Serialized with
   * BEGIN IMMEDIATE so two workers cannot POST the same follow-up.
   */
  leaseDue(
    now: Date,
    options: { leaseMs?: number; limit?: number } = {},
  ): PendingCloudNudge[] {
    const leaseMs = options.leaseMs ?? NUDGE_QUEUE_LEASE_MS;
    const limit = options.limit ?? 20;
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM pending_cloud_nudges
           WHERE next_retry_at <= ?
             AND (lease_until IS NULL OR lease_until < ?)
           ORDER BY next_retry_at ASC
           LIMIT ?`,
        )
        .all(nowIso, nowIso, limit) as Record<string, unknown>[];
      const update = this.db.prepare(
        `UPDATE pending_cloud_nudges SET lease_until = ? WHERE id = ?`,
      );
      for (const row of rows) {
        update.run(leaseUntil, Number(row.id));
      }
      this.db.exec("COMMIT");
      return rows.map((row) =>
        mapNudgeRow({ ...row, lease_until: leaseUntil }),
      );
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw error;
    }
  }

  deleteById(id: number): void {
    this.db.prepare(`DELETE FROM pending_cloud_nudges WHERE id = ?`).run(id);
  }

  deleteBySlug(slug: string): void {
    this.db
      .prepare(`DELETE FROM pending_cloud_nudges WHERE ticket_slug = ?`)
      .run(slug);
  }

  recordBusy(input: {
    id: number;
    attempts: number;
    next_retry_at: string;
    last_status: number;
  }): void {
    this.db
      .prepare(
        `UPDATE pending_cloud_nudges
         SET attempts = ?, next_retry_at = ?, last_status = ?, lease_until = NULL
         WHERE id = ?`,
      )
      .run(input.attempts, input.next_retry_at, input.last_status, input.id);
  }

  clearLease(id: number): void {
    this.db
      .prepare(
        `UPDATE pending_cloud_nudges SET lease_until = NULL WHERE id = ?`,
      )
      .run(id);
  }

  close() {
    this.db.close();
  }
}

function mapNudgeRow(row: Record<string, unknown>): PendingCloudNudge {
  return {
    id: Number(row.id),
    ticket_slug: String(row.ticket_slug),
    agent_id: String(row.agent_id),
    verdict: String(row.verdict),
    stage: String(row.stage),
    ticket_key: row.ticket_key == null ? null : String(row.ticket_key),
    prompt: String(row.prompt),
    first_attempt_at: String(row.first_attempt_at),
    next_retry_at: String(row.next_retry_at),
    attempts: Number(row.attempts),
    lease_until: row.lease_until == null ? null : String(row.lease_until),
    last_status: row.last_status == null ? null : Number(row.last_status),
  };
}

export function enqueueBusyCloudNudgeForVerdict(
  store: NudgeQueueStore,
  ticket: Ticket,
  verdict: string,
  result: NudgeClaimResult,
  now: Date = new Date(),
): PendingCloudNudge {
  const next = new Date(now.getTime() + AGENT_BUSY_RETRY_MS);
  return store.upsert({
    ticket_slug: ticket.slug,
    agent_id: result.agentId,
    verdict,
    stage: ticket.fields.stage,
    ticket_key: ticket.fields.ticket_key ?? null,
    prompt: result.prompt,
    first_attempt_at: now.toISOString(),
    next_retry_at: next.toISOString(),
    attempts: 1,
    last_status: result.status || null,
  });
}

export type NudgeQueueWorkerDeps = {
  store: NudgeQueueStore;
  getClient: (ticket: Ticket) => CursorCloudFollowUp | null | undefined;
  loadTicket: (slug: string) => Promise<Ticket | null>;
  addComment: (input: { ticket: string; body: string }) => Promise<unknown>;
  now?: () => Date;
  leaseMs?: number;
  log?: (message: string) => void;
};

export async function processDueCloudNudges(
  deps: NudgeQueueWorkerDeps,
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const log = deps.log ?? ((message: string) => console.warn(message));
  let leased: PendingCloudNudge[];
  try {
    leased = deps.store.leaseDue(now, { leaseMs: deps.leaseMs });
  } catch (error) {
    log(
      `[traceai] cursor cloud nudge queue lease failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  for (const row of leased) {
    try {
      await processOneNudge(deps, row, now, log);
    } catch (error) {
      log(
        `[traceai] cursor cloud nudge queue row failed for ${row.ticket_slug}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      try {
        deps.store.clearLease(row.id);
      } catch {
        // ignore
      }
    }
  }
}

async function processOneNudge(
  deps: NudgeQueueWorkerDeps,
  row: PendingCloudNudge,
  now: Date,
  log: (message: string) => void,
): Promise<void> {
  const firstAt = Date.parse(row.first_attempt_at);
  const windowElapsed =
    Number.isFinite(firstAt) &&
    now.getTime() - firstAt >= AGENT_BUSY_RETRY_WINDOW_MS;

  let ticket: Ticket | null;
  try {
    ticket = await deps.loadTicket(row.ticket_slug);
  } catch (error) {
    log(
      `[traceai] cursor cloud nudge reload failed for ${row.ticket_slug}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    deps.store.clearLease(row.id);
    return;
  }

  const currentId = normalizeClaimedAgentId(ticket?.fields.claimed_agent_id);
  if (!ticket || claimedAgentKind(currentId) !== "cursor_cloud") {
    deps.store.deleteById(row.id);
    return;
  }

  if (windowElapsed) {
    await skipQueuedNudge(deps, row, currentId, ticket, "window_elapsed", log);
    return;
  }

  const client = deps.getClient(ticket);
  if (!client) {
    await skipQueuedNudge(deps, row, currentId, ticket, "missing_key", log);
    return;
  }

  const verdict = row.verdict;
  const prompt = cloudWakeupPrompt({
    ticketKey: ticket?.fields.ticket_key ?? row.ticket_key,
    slug: row.ticket_slug,
    verdict,
    stage: ticket?.fields.stage ?? row.stage,
  });

  const result = await client.followUp(currentId, prompt);
  if (result.ok) {
    deps.store.deleteById(row.id);
    return;
  }
  if (result.busy) {
    const attempts = row.attempts + 1;
    const delay = agentBusyRetryDelayMs(attempts);
    deps.store.recordBusy({
      id: row.id,
      attempts,
      next_retry_at: new Date(now.getTime() + delay).toISOString(),
      last_status: result.status,
    });
    return;
  }

  await skipQueuedNudge(
    deps,
    { ...row, last_status: result.status },
    currentId,
    ticket,
    "non_busy_error",
    log,
  );
}

async function skipQueuedNudge(
  deps: NudgeQueueWorkerDeps,
  row: PendingCloudNudge,
  agentId: string,
  ticket: Ticket | null,
  kind: "window_elapsed" | "non_busy_error" | "missing_key",
  log: (message: string) => void,
): Promise<void> {
  const reason = cloudNudgeSkipReason({
    kind,
    status: row.last_status ?? undefined,
  });
  const attempts =
    kind === "non_busy_error" ? row.attempts + 1 : row.attempts;
  const body = cloudNudgeSkipComment({
    ticketKey: ticket?.fields.ticket_key ?? row.ticket_key,
    slug: row.ticket_slug,
    verdict: row.verdict,
    agentId,
    attempts,
    reason,
  });
  log(
    `[traceai] cursor cloud nudge skipped for ${row.ticket_slug} (${agentId}) after ${attempts} attempt(s): ${reason}`,
  );
  try {
    await deps.addComment({ ticket: row.ticket_slug, body });
  } catch (error) {
    log(
      `[traceai] cursor cloud nudge skip comment failed for ${row.ticket_slug}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  deps.store.deleteById(row.id);
}

export function startNudgeQueuePoller(
  deps: NudgeQueueWorkerDeps & { pollMs?: number },
): { stop: () => void; tick: () => Promise<void> } {
  const pollMs = deps.pollMs ?? NUDGE_QUEUE_POLL_MS;
  const tick = () => processDueCloudNudges(deps);
  const timer =
    pollMs > 0
      ? setInterval(() => {
          void tick().catch((error) => {
            const log = deps.log ?? ((message: string) => console.warn(message));
            log(
              `[traceai] cursor cloud nudge poller failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
        }, pollMs)
      : null;
  if (timer && typeof timer.unref === "function") timer.unref();
  return {
    stop() {
      if (timer) clearInterval(timer);
    },
    tick,
  };
}

let defaultStore: NudgeQueueStore | null = null;

export function configureNudgeQueueStore(dbPath: string): NudgeQueueStore {
  defaultStore?.close();
  defaultStore = new NudgeQueueStore(dbPath);
  return defaultStore;
}

export function getNudgeQueueStore(): NudgeQueueStore | null {
  return defaultStore;
}
