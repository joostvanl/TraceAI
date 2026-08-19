import { randomUUID } from "node:crypto";
import type { Context, Next } from "hono";
import {
  hasScope,
  isTraceaiToken,
  type AuthActor,
  type AuthStore,
  type Scope,
} from "@traceai/auth";
import type { Principal, ProjectAccess } from "./principal.js";
import type { ProjectGuard } from "./project-guard.js";

export type AppVariables = {
  actor: AuthActor;
  requestId: string;
  authStore: AuthStore;
  /** Set by the project-access middleware so routes need no second lookup. */
  principal?: Principal;
  projectAccess?: ProjectAccess;
  /**
   * Lazy principal/access resolver for every `/v1/*` route (TRA-82). Routes whose
   * project is not in the path have no `principal` above, so they use this.
   */
  projectGuard?: ProjectGuard;
};

export function requestIdMiddleware() {
  return async (c: Context, next: Next) => {
    const incoming = c.req.header("x-request-id");
    const requestId = incoming && incoming.trim() ? incoming : randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    await next();
  };
}

export function createAuthMiddleware(authStore: AuthStore) {
  return async (c: Context, next: Next) => {
    const header = c.req.header("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return c.json(
        { message: "Missing Bearer token", code: "UNAUTHORIZED" },
        401,
      );
    }
    const raw = match[1].trim();
    if (!isTraceaiToken(raw)) {
      return c.json(
        {
          message: "Expected a TraceAI token (trc_…)",
          code: "INVALID_TOKEN",
        },
        401,
      );
    }

    const auth = authStore.authenticate(raw);
    if (!auth) {
      return c.json(
        {
          message: "Invalid, revoked, or expired TraceAI token",
          code: "UNAUTHORIZED",
        },
        401,
      );
    }

    const actor: AuthActor = {
      userId: auth.user.id,
      email: auth.user.email,
      name: auth.user.name,
      tokenId: auth.token.id,
      scopes: auth.token.scopes,
    };
    c.set("actor", actor);
    c.set("authStore", authStore);
    await next();
  };
}

export function requireScope(...scopes: Scope[]) {
  return async (c: Context, next: Next) => {
    const actor = c.get("actor") as AuthActor | undefined;
    if (!actor) {
      return c.json({ message: "Unauthorized", code: "UNAUTHORIZED" }, 401);
    }
    if (!hasScope(actor.scopes, scopes)) {
      return c.json(
        {
          message: `Missing required scope: ${scopes.join(", ")}`,
          code: "FORBIDDEN",
        },
        403,
      );
    }
    await next();
  };
}

export function audit(
  c: Context,
  input: {
    action: string;
    resourceType: string;
    resourceId?: string | null;
    meta?: unknown;
  },
) {
  const actor = c.get("actor") as AuthActor;
  const authStore = c.get("authStore") as AuthStore;
  const requestId = c.get("requestId") as string;
  return authStore.appendAudit({
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    actorUserId: actor.userId,
    actorTokenId: actor.tokenId,
    requestId,
    meta: input.meta,
  });
}
