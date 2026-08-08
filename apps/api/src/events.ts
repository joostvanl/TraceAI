import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type TicketEventType =
  | "ticket.created"
  | "ticket.updated"
  | "ticket.transitioned"
  | "ticket.commented"
  | "ticket.reviewed";

export type TicketEventTicket = {
  slug: string;
  ticket_key?: string | null;
  title: string;
  stage: string;
  priority: string;
  created_by: string | null;
  project: string;
  workflow?: string;
  tokens_estimate?: number | null;
  tokens_actual?: number | null;
  resolution?: string | null;
  review_state?: string | null;
  review_by?: string | null;
  review_at?: string | null;
};

export type TicketEvent = {
  type: TicketEventType;
  project: string;
  ticket: TicketEventTicket;
  from_stage?: string;
  to_stage?: string;
  at: string;
};

/** A persisted event plus its monotonic store id (used as the SSE `id:`). */
export type TicketEventRecord = {
  event_id: number;
  event: TicketEvent;
};

/**
 * Append-only durable store for ticket events, backed by SQLite (`node:sqlite`,
 * the same driver the auth store already uses — no new dependency). Every event
 * gets a monotonic `event_id`, so clients can replay from any point via
 * `Last-Event-ID` / `?after=`, and events survive API process restarts.
 *
 * A file-backed store shared between API workers (WAL mode) also gives us
 * cross-process fan-out: each worker polls for rows written by any other
 * worker, so an MCP write on one instance reaches SSE clients on all of them.
 */
export class TicketEventStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ticket_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ticket_events_project
        ON ticket_events(project, event_id);
    `);
  }

  append(event: TicketEvent): TicketEventRecord {
    const result = this.db
      .prepare(
        `INSERT INTO ticket_events (project, type, payload, at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(event.project, event.type, JSON.stringify(event), event.at);
    return { event_id: Number(result.lastInsertRowid), event };
  }

  /** Events with `event_id` strictly greater than `afterId`, ascending. */
  readAfter(
    afterId: number,
    options: { project?: string; limit?: number } = {},
  ): TicketEventRecord[] {
    const limit = options.limit ?? 500;
    const rows = (
      options.project
        ? this.db
            .prepare(
              `SELECT event_id, payload FROM ticket_events
               WHERE event_id > ? AND project = ?
               ORDER BY event_id ASC LIMIT ?`,
            )
            .all(afterId, options.project, limit)
        : this.db
            .prepare(
              `SELECT event_id, payload FROM ticket_events
               WHERE event_id > ?
               ORDER BY event_id ASC LIMIT ?`,
            )
            .all(afterId, limit)
    ) as Array<{ event_id: number | bigint; payload: string }>;

    return rows.map((row) => ({
      event_id: Number(row.event_id),
      event: JSON.parse(row.payload) as TicketEvent,
    }));
  }

  latestId(): number {
    const row = this.db
      .prepare(`SELECT MAX(event_id) AS max_id FROM ticket_events`)
      .get() as { max_id: number | bigint | null } | undefined;
    return row?.max_id == null ? 0 : Number(row.max_id);
  }

  close() {
    this.db.close();
  }
}

type Notify = () => void;

/**
 * Backs `publishTicketEvent` with the durable store and a cross-process
 * notification loop. Subscribers are told "something changed" and are expected
 * to drain from the store (`getEventsAfter`) in id order, which keeps delivery
 * gap-free and ordered even when events arrive from another process.
 */
export class TicketEventBus {
  private readonly subscribers = new Set<Notify>();
  private readonly pollTimer: ReturnType<typeof setInterval> | null;
  private lastSeenId: number;

  constructor(
    private readonly store: TicketEventStore,
    options: { pollMs?: number } = {},
  ) {
    this.lastSeenId = store.latestId();
    const pollMs = options.pollMs ?? 0;
    if (pollMs > 0) {
      this.pollTimer = setInterval(() => this.pump(), pollMs);
      // Don't keep the event loop alive just for polling.
      (this.pollTimer as unknown as { unref?: () => void }).unref?.();
    } else {
      this.pollTimer = null;
    }
  }

  publish(event: TicketEvent): TicketEventRecord {
    const record = this.store.append(event);
    // Local subscribers see it immediately; other processes catch up on poll.
    this.notify();
    return record;
  }

  subscribe(listener: Notify): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  getEventsAfter(afterId: number, project?: string): TicketEventRecord[] {
    return this.store.readAfter(afterId, { project });
  }

  latestId(): number {
    return this.store.latestId();
  }

  /** Check the store for new rows (e.g. written by another process). */
  pump() {
    const latest = this.store.latestId();
    if (latest > this.lastSeenId) {
      this.lastSeenId = latest;
      this.notify();
    }
  }

  private notify() {
    for (const listener of this.subscribers) {
      try {
        listener();
      } catch (error) {
        console.error("ticket event subscriber failed", error);
      }
    }
  }

  close() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.subscribers.clear();
  }
}

let defaultBus: TicketEventBus | null = null;

/** Initialize the process-wide event bus (call once at startup). */
export function configureEventBus(options: {
  dbPath: string;
  pollMs?: number;
}): TicketEventBus {
  defaultBus?.close();
  defaultBus = new TicketEventBus(new TicketEventStore(options.dbPath), {
    pollMs: options.pollMs,
  });
  return defaultBus;
}

function getBus(): TicketEventBus {
  if (!defaultBus) {
    // Fallback for tooling/tests that never called configureEventBus.
    defaultBus = new TicketEventBus(
      new TicketEventStore(process.env.TRACEAI_EVENTS_DB ?? ":memory:"),
    );
  }
  return defaultBus;
}

export function publishTicketEvent(event: TicketEvent): TicketEventRecord {
  return getBus().publish(event);
}

/**
 * Subscribe to change notifications. The callback receives no payload on
 * purpose: subscribers drain from the store via `getEventsAfter` to stay
 * ordered and gap-free across processes.
 */
export function subscribeTicketEvents(listener: Notify): () => void {
  return getBus().subscribe(listener);
}

export function getEventsAfter(
  afterId: number,
  project?: string,
): TicketEventRecord[] {
  return getBus().getEventsAfter(afterId, project);
}

export function latestEventId(): number {
  return getBus().latestId();
}

export function ticketEventFromMapped(
  type: TicketEventType,
  ticket: {
    slug: string;
    ticket_key?: string | null;
    title: string;
    stage: string;
    priority?: string | null;
    created_by?: string | null;
    project: string;
    workflow?: string;
    tokens_estimate?: number | null;
    tokens_actual?: number | null;
    resolution?: string | null;
    review_state?: string | null;
    review_by?: string | null;
    review_at?: string | null;
  },
  extra: Partial<Pick<TicketEvent, "from_stage" | "to_stage">> = {},
): TicketEvent {
  return {
    type,
    project: ticket.project,
    ticket: {
      slug: ticket.slug,
      ticket_key: ticket.ticket_key ?? null,
      title: ticket.title,
      stage: ticket.stage,
      priority: ticket.priority ?? "medium",
      created_by: ticket.created_by ?? null,
      project: ticket.project,
      workflow: ticket.workflow,
      tokens_estimate: ticket.tokens_estimate ?? null,
      tokens_actual: ticket.tokens_actual ?? null,
      resolution: ticket.resolution ?? null,
      review_state: ticket.review_state ?? null,
      review_by: ticket.review_by ?? null,
      review_at: ticket.review_at ?? null,
    },
    ...extra,
    at: new Date().toISOString(),
  };
}
