import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type NotificationType = "review_requested" | "review_cascaded";

export type NotificationRecord = {
  id: number;
  recipient: string;
  type: NotificationType;
  project: string;
  ticket_slug: string;
  ticket_key: string | null;
  title: string;
  stage: string;
  deeplink: string;
  read: boolean;
  created_at: string;
};

export type CreateNotificationInput = {
  recipient: string;
  type: NotificationType;
  project: string;
  ticket_slug: string;
  ticket_key?: string | null;
  title: string;
  stage: string;
  deeplink: string;
};

/**
 * Ephemeral in-app notifications (bell / unread). File-backed SQLite so
 * mark-read is cheap and survives API restarts — same driver as auth/events.
 */
export class NotificationStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient TEXT NOT NULL,
        type TEXT NOT NULL,
        project TEXT NOT NULL,
        ticket_slug TEXT NOT NULL,
        ticket_key TEXT,
        title TEXT NOT NULL,
        stage TEXT NOT NULL,
        deeplink TEXT NOT NULL,
        read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_recipient
        ON notifications(recipient, read, id DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_ticket
        ON notifications(ticket_slug, type, read);
    `);
  }

  /**
   * Insert a notification unless an unread of the same type+ticket already
   * exists for this recipient (scenario D dedupe).
   */
  notify(input: CreateNotificationInput): NotificationRecord | null {
    const existing = this.db
      .prepare(
        `SELECT id FROM notifications
         WHERE recipient = ? AND type = ? AND ticket_slug = ? AND read = 0
         LIMIT 1`,
      )
      .get(input.recipient, input.type, input.ticket_slug) as
      | { id: number }
      | undefined;
    if (existing) return null;

    const created_at = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO notifications
          (recipient, type, project, ticket_slug, ticket_key, title, stage, deeplink, read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        input.recipient,
        input.type,
        input.project,
        input.ticket_slug,
        input.ticket_key ?? null,
        input.title,
        input.stage,
        input.deeplink,
        created_at,
      );
    return this.getById(Number(result.lastInsertRowid))!;
  }

  listForRecipient(
    recipient: string,
    options: { unreadOnly?: boolean; limit?: number } = {},
  ): NotificationRecord[] {
    const limit = options.limit ?? 50;
    const rows = (
      options.unreadOnly
        ? this.db
            .prepare(
              `SELECT * FROM notifications
               WHERE recipient = ? AND read = 0
               ORDER BY id DESC LIMIT ?`,
            )
            .all(recipient, limit)
        : this.db
            .prepare(
              `SELECT * FROM notifications
               WHERE recipient = ?
               ORDER BY id DESC LIMIT ?`,
            )
            .all(recipient, limit)
    ) as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  }

  unreadCount(recipient: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM notifications
         WHERE recipient = ? AND read = 0`,
      )
      .get(recipient) as { c: number | bigint };
    return Number(row.c);
  }

  markRead(recipient: string, id: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE notifications SET read = 1
         WHERE id = ? AND recipient = ? AND read = 0`,
      )
      .run(id, recipient);
    return Number(result.changes) > 0;
  }

  markAllRead(recipient: string): number {
    const result = this.db
      .prepare(
        `UPDATE notifications SET read = 1
         WHERE recipient = ? AND read = 0`,
      )
      .run(recipient);
    return Number(result.changes);
  }

  /** Mark unread review_* notifications for a ticket as read (after verdict). */
  markTicketReviewRead(ticketSlug: string): number {
    const result = this.db
      .prepare(
        `UPDATE notifications SET read = 1
         WHERE ticket_slug = ?
           AND read = 0
           AND type IN ('review_requested', 'review_cascaded')`,
      )
      .run(ticketSlug);
    return Number(result.changes);
  }

  private getById(id: number): NotificationRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM notifications WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : null;
  }
}

function mapRow(row: Record<string, unknown>): NotificationRecord {
  return {
    id: Number(row.id),
    recipient: String(row.recipient),
    type: row.type as NotificationType,
    project: String(row.project),
    ticket_slug: String(row.ticket_slug),
    ticket_key: row.ticket_key == null ? null : String(row.ticket_key),
    title: String(row.title),
    stage: String(row.stage),
    deeplink: String(row.deeplink),
    read: Number(row.read) === 1,
    created_at: String(row.created_at),
  };
}

let store: NotificationStore | null = null;

export function configureNotificationStore(dbPath: string) {
  store = new NotificationStore(dbPath);
  return store;
}

export function getNotificationStore(): NotificationStore {
  if (!store) {
    throw new Error("Notification store not configured");
  }
  return store;
}
