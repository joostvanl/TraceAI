import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  generateRawToken,
  hashToken,
  newId,
  tokenPrefixHint,
} from "./crypto.js";
import {
  DEFAULT_AGENT_SCOPES,
  type AuditEntry,
  type CreatedToken,
  type Scope,
  type TraceToken,
  type TraceTokenPublic,
  type TraceUser,
  type UserStatus,
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function parseScopes(raw: string): Scope[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((s) => String(s) as Scope);
  } catch {
    return [];
  }
}

export class AuthStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        token_prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        actor_user_id TEXT NOT NULL,
        actor_token_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        meta TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tokens_hash ON tokens(token_hash);
      CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_user_id);
    `);
  }

  close() {
    this.db.close();
  }

  createUser(input: {
    email: string;
    name: string;
    status?: UserStatus;
  }): TraceUser {
    const ts = nowIso();
    const user: TraceUser = {
      id: newId("usr"),
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
      status: input.status ?? "active",
      createdAt: ts,
      updatedAt: ts,
    };
    this.db
      .prepare(
        `INSERT INTO users (id, email, name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        user.id,
        user.email,
        user.name,
        user.status,
        user.createdAt,
        user.updatedAt,
      );
    return user;
  }

  getUser(id: string): TraceUser | null {
    const row = this.db
      .prepare(
        `SELECT id, email, name, status, created_at, updated_at FROM users WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          email: string;
          name: string;
          status: UserStatus;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getUserByEmail(email: string): TraceUser | null {
    const row = this.db
      .prepare(
        `SELECT id, email, name, status, created_at, updated_at FROM users WHERE email = ?`,
      )
      .get(email.trim().toLowerCase()) as
      | {
          id: string;
          email: string;
          name: string;
          status: UserStatus;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listUsers(): TraceUser[] {
    const rows = this.db
      .prepare(
        `SELECT id, email, name, status, created_at, updated_at FROM users ORDER BY created_at ASC`,
      )
      .all() as Array<{
      id: string;
      email: string;
      name: string;
      status: UserStatus;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  createToken(input: {
    userId: string;
    name: string;
    scopes?: Scope[];
    expiresAt?: string | null;
  }): CreatedToken {
    const user = this.getUser(input.userId);
    if (!user) throw new Error(`User not found: ${input.userId}`);
    if (user.status !== "active") throw new Error("User is disabled");

    const raw = generateRawToken();
    const token: TraceToken = {
      id: newId("tok"),
      userId: input.userId,
      name: input.name.trim(),
      tokenPrefix: tokenPrefixHint(raw),
      tokenHash: hashToken(raw),
      scopes: input.scopes ?? DEFAULT_AGENT_SCOPES,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: nowIso(),
    };

    this.db
      .prepare(
        `INSERT INTO tokens (
          id, user_id, name, token_prefix, token_hash, scopes,
          expires_at, revoked_at, last_used_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        token.id,
        token.userId,
        token.name,
        token.tokenPrefix,
        token.tokenHash,
        JSON.stringify(token.scopes),
        token.expiresAt,
        token.revokedAt,
        token.lastUsedAt,
        token.createdAt,
      );

    const { tokenHash: _, ...publicToken } = token;
    return { ...publicToken, token: raw };
  }

  listTokens(userId?: string): TraceTokenPublic[] {
    const rows = (
      userId
        ? this.db
            .prepare(
              `SELECT * FROM tokens WHERE user_id = ? ORDER BY created_at DESC`,
            )
            .all(userId)
        : this.db
            .prepare(`SELECT * FROM tokens ORDER BY created_at DESC`)
            .all()
    ) as Array<Record<string, unknown>>;

    return rows.map((row) => this.mapToken(row));
  }

  revokeToken(tokenId: string): TraceTokenPublic | null {
    const existing = this.db
      .prepare(`SELECT * FROM tokens WHERE id = ?`)
      .get(tokenId) as Record<string, unknown> | undefined;
    if (!existing) return null;
    const ts = nowIso();
    this.db
      .prepare(`UPDATE tokens SET revoked_at = ? WHERE id = ?`)
      .run(ts, tokenId);
    return this.mapToken({ ...existing, revoked_at: ts });
  }

  authenticate(
    rawToken: string,
  ): { user: TraceUser; token: TraceTokenPublic } | null {
    const hash = hashToken(rawToken);
    const row = this.db
      .prepare(`SELECT * FROM tokens WHERE token_hash = ?`)
      .get(hash) as Record<string, unknown> | undefined;
    if (!row) return null;

    const token = this.mapToken(row);
    if (token.revokedAt) return null;
    if (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now()) {
      return null;
    }

    const user = this.getUser(token.userId);
    if (!user || user.status !== "active") return null;

    const ts = nowIso();
    this.db
      .prepare(`UPDATE tokens SET last_used_at = ? WHERE id = ?`)
      .run(ts, token.id);

    return { user, token: { ...token, lastUsedAt: ts } };
  }

  appendAudit(input: {
    action: string;
    resourceType: string;
    resourceId?: string | null;
    actorUserId: string;
    actorTokenId: string;
    requestId: string;
    meta?: unknown;
  }): AuditEntry {
    const entry: AuditEntry = {
      id: newId("aud"),
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      actorUserId: input.actorUserId,
      actorTokenId: input.actorTokenId,
      requestId: input.requestId,
      meta: input.meta == null ? null : JSON.stringify(input.meta),
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO audit_log (
          id, action, resource_type, resource_id, actor_user_id,
          actor_token_id, request_id, meta, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.action,
        entry.resourceType,
        entry.resourceId,
        entry.actorUserId,
        entry.actorTokenId,
        entry.requestId,
        entry.meta,
        entry.createdAt,
      );
    return entry;
  }

  listAudit(limit = 50): AuditEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      action: String(row.action),
      resourceType: String(row.resource_type),
      resourceId: row.resource_id == null ? null : String(row.resource_id),
      actorUserId: String(row.actor_user_id),
      actorTokenId: String(row.actor_token_id),
      requestId: String(row.request_id),
      meta: row.meta == null ? null : String(row.meta),
      createdAt: String(row.created_at),
    }));
  }

  private mapToken(row: Record<string, unknown>): TraceTokenPublic {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      name: String(row.name),
      tokenPrefix: String(row.token_prefix),
      scopes: parseScopes(String(row.scopes)),
      expiresAt: row.expires_at == null ? null : String(row.expires_at),
      revokedAt: row.revoked_at == null ? null : String(row.revoked_at),
      lastUsedAt: row.last_used_at == null ? null : String(row.last_used_at),
      createdAt: String(row.created_at),
    };
  }
}
