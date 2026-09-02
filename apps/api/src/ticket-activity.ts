import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const ACTIVITY_TTL_MS = 120_000;
export const ACTIVITY_MAX_CHARS = 80;

export type TicketActivityRow = {
  ticket_slug: string;
  project: string;
  text: string;
  expires_at: string;
  updated_at: string;
};

/**
 * Last-write-wins ephemeral board activity (TRA-141). Sibling SQLite file —
 * not Aurora, not comments, not the events log.
 */
export class TicketActivityStore {
  private readonly db: DatabaseSync;

  constructor(
    dbPath: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ticket_activity (
        ticket_slug TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        text TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ticket_activity_project
        ON ticket_activity(project, expires_at);
    `);
  }

  set(
    slug: string,
    project: string,
    text: string,
  ): TicketActivityRow | null {
    const trimmed = text.trim();
    if (!trimmed) {
      this.clear(slug);
      return null;
    }
    const updated_at = this.now().toISOString();
    const expires_at = new Date(this.now().getTime() + ACTIVITY_TTL_MS).toISOString();
    this.db
      .prepare(
        `INSERT INTO ticket_activity (ticket_slug, project, text, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(ticket_slug) DO UPDATE SET
           project = excluded.project,
           text = excluded.text,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      )
      .run(slug, project, trimmed, expires_at, updated_at);
    return { ticket_slug: slug, project, text: trimmed, expires_at, updated_at };
  }

  clear(slug: string): void {
    this.db
      .prepare(`DELETE FROM ticket_activity WHERE ticket_slug = ?`)
      .run(slug);
  }

  getMany(project: string): TicketActivityRow[] {
    const nowIso = this.now().toISOString();
    const rows = this.db
      .prepare(
        `SELECT ticket_slug, project, text, expires_at, updated_at
         FROM ticket_activity
         WHERE project = ? AND expires_at > ?
         ORDER BY updated_at DESC`,
      )
      .all(project, nowIso) as TicketActivityRow[];
    return rows.map((row) => ({
      ticket_slug: String(row.ticket_slug),
      project: String(row.project),
      text: String(row.text),
      expires_at: String(row.expires_at),
      updated_at: String(row.updated_at),
    }));
  }

  close() {
    this.db.close();
  }
}

let store: TicketActivityStore | null = null;

export function configureTicketActivityStore(dbPath: string) {
  store?.close();
  store = new TicketActivityStore(dbPath);
  return store;
}

export function getTicketActivityStore(): TicketActivityStore {
  if (!store) {
    store = new TicketActivityStore(
      process.env.TRACEAI_ACTIVITY_DB ?? ":memory:",
    );
  }
  return store;
}
