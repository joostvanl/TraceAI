import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "app.ts"), "utf8");

/**
 * TRA-82. The TRA-81 guard test only looked at routes under `/v1/projects/`,
 * so the whole class of routes that take their project from a query parameter or
 * from the loaded resource never entered its sample. That is why a non-member
 * could read ticket descriptions for weeks with a green suite.
 *
 * This test is two-sided on purpose: it fails both when a project-scoped route
 * forgets its check *and* when a new route appears that is in neither list.
 * Without that second half, PROJECT_SCOPED is just a snapshot that quietly falls
 * behind — the exact failure it is meant to prevent.
 */

/** Routes whose handler must run a project check. */
const PROJECT_SCOPED = [
  "GET /v1/tickets",
  "GET /v1/tickets/:slug",
  "POST /v1/tickets",
  "PATCH /v1/tickets/:slug",
  "POST /v1/tickets/reorder",
  "POST /v1/tickets/:slug/transition",
  "POST /v1/tickets/:slug/review",
  "POST /v1/tickets/:slug/claim",
  "POST /v1/comments",
  "GET /v1/wiki-pages",
  "GET /v1/wiki-pages/:slug",
  "POST /v1/wiki-pages",
  "PATCH /v1/wiki-pages/:slug",
  "GET /v1/workflows",
  "GET /v1/workflows/:slug",
  "POST /v1/workflows",
  "PATCH /v1/workflows/:slug",
  "POST /v1/workflows/:slug/draft",
  "GET /v1/workflows/:slug/activation-preview",
  "POST /v1/workflows/:slug/activate",
  "GET /v1/workflows/:slug/versions",
  "POST /v1/workflows/:slug/versions/:versionId/restore",
  "POST /v1/workflows/:slug/templates/apply",
  "GET /events",
];

/**
 * Routes with no project to check — each with the reason, so "no project here"
 * is a claim someone made and not something nobody looked at.
 */
const NOT_PROJECT_SCOPED: Record<string, string> = {
  "GET /health": "liveness probe, returns no data",
  "GET /metrics": "Prometheus scrape; process-wide series, no ticket payload",
  "GET /v1/me": "describes the calling token",
  "GET /v1/me/tokens": "the caller's own tokens",
  "POST /v1/me/tokens": "the caller's own tokens",
  "POST /v1/me/tokens/:id/revoke": "the caller's own tokens",
  "GET /v1/ui/login/status": "pre-authentication login flow",
  "POST /v1/ui/login/verify": "pre-authentication login flow",
  "GET /v1/projects": "cross-project list; filters itself on access",
  "GET /v1/me/projects": "cross-project list; filters itself on access",
  "POST /v1/projects":
    "creating a project is how a user without memberships gains access (TRA-81 F2)",
  "GET /v1/traceai-users": "admin scope",
  "POST /v1/traceai-users": "admin scope",
  "PATCH /v1/traceai-users/:slug": "admin scope",
  "GET /v1/inbox/reviews": "already membership-aware per recipient (TRA-44)",
  "GET /v1/notifications": "scoped to the signed-in recipient",
  "POST /v1/notifications/mark-read": "scoped to the signed-in recipient",
  "GET /v1/admin/users": "admin scope",
  "POST /v1/admin/users": "admin scope",
  "GET /v1/admin/tokens": "admin scope",
  "POST /v1/admin/tokens": "admin scope",
  "POST /v1/admin/tokens/:id/revoke": "admin scope",
  "GET /v1/admin/audit": "admin scope",
};

/** Routes that filter themselves and must show it. */
const SELF_FILTERING = ["GET /v1/projects", "GET /v1/me/projects"];

/**
 * Skips strings and comments so parentheses inside them do not shift the depth.
 * Slicing "from this route to the next" instead — the obvious shortcut — reads
 * whatever sits between two routes as part of the first one. That produced a
 * false positive for `/events` while writing this: the helper definitions
 * following it made it look guarded.
 */
function handlerBody(from: number): string {
  let i = source.indexOf("(", from);
  let depth = 0;
  const start = i;
  for (; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      i = source.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    if (ch === "/" && next === "*") {
      i = source.indexOf("*/", i);
      if (i === -1) break;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      for (; i < source.length; i++) {
        if (source[i] === "\\") {
          i += 1;
          continue;
        }
        if (source[i] === quote) break;
      }
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

type Route = { key: string; path: string; body: string };

function routes(): Route[] {
  const re = /app\.(get|post|patch|delete)\(\s*\n?\s*"([^"]+)"/g;
  const found: Route[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    found.push({
      key: `${m[1].toUpperCase()} ${m[2]}`,
      path: m[2],
      body: handlerBody(m.index),
    });
  }
  return found;
}

function coveredByMiddleware(path: string): boolean {
  return path === "/v1/projects/:slug" || path.startsWith("/v1/projects/:slug/");
}

function callsProjectCheck(body: string): boolean {
  return (
    body.includes("denyUnlessProjectVisible(") ||
    body.includes("denyWorkflowAccess(")
  );
}

describe("project-scoped routes outside /v1/projects (TRA-82)", () => {
  const all = routes();

  it("finds the routes at all", () => {
    // A floor: if the regex breaks, every other assertion would pass vacuously.
    assert.ok(all.length >= 40, `only found ${all.length} routes`);
  });

  it("G1: every route is in exactly one bucket", () => {
    const unclassified = all
      .filter(
        (r) =>
          !coveredByMiddleware(r.path) &&
          !PROJECT_SCOPED.includes(r.key) &&
          !(r.key in NOT_PROJECT_SCOPED),
      )
      .map((r) => r.key);

    assert.deepEqual(
      unclassified,
      [],
      `new route(s) with no decision about project access: ${unclassified.join(", ")}. ` +
        "Add a project check and list them in PROJECT_SCOPED, or add them to " +
        "NOT_PROJECT_SCOPED with the reason there is no project.",
    );

    const both = all
      .filter((r) => PROJECT_SCOPED.includes(r.key) && r.key in NOT_PROJECT_SCOPED)
      .map((r) => r.key);
    assert.deepEqual(both, [], "a route cannot be both scoped and unscoped");
  });

  it("G2: every PROJECT_SCOPED route actually runs the check", () => {
    const missing = all
      .filter((r) => PROJECT_SCOPED.includes(r.key) && !callsProjectCheck(r.body))
      .map((r) => r.key);
    assert.deepEqual(
      missing,
      [],
      `these routes are project-scoped but call no project check: ${missing.join(", ")}`,
    );
  });

  it("G2b: the lists name no route that does not exist", () => {
    const keys = new Set(all.map((r) => r.key));
    const stale = [
      ...PROJECT_SCOPED,
      ...Object.keys(NOT_PROJECT_SCOPED),
    ].filter((key) => !keys.has(key));
    assert.deepEqual(
      stale,
      [],
      `listed but no longer registered: ${stale.join(", ")} — a stale entry hides a renamed route`,
    );
  });

  it("G4: every allowlist entry carries a reason", () => {
    const empty = Object.entries(NOT_PROJECT_SCOPED)
      .filter(([, reason]) => reason.trim().length < 10)
      .map(([key]) => key);
    assert.deepEqual(empty, [], "an allowlist without a reason is a to-do list");
  });

  it("G5: self-filtering lists really filter", () => {
    for (const key of SELF_FILTERING) {
      const route = all.find((r) => r.key === key);
      assert.ok(route, `${key} is gone; update SELF_FILTERING`);
      assert.match(
        route.body,
        /mayAccessProject\(|allowedProjects\(|accessibleProjectSlugs\(/,
        `${key} claims to filter itself but never consults project access`,
      );
    }
  });

  it("the guard is mounted for every /v1 route", () => {
    assert.match(
      source,
      /app\.use\(\s*\n?\s*"\/v1\/\*",\s*\n?\s*projectGuardMiddleware\(/,
      "without this mount the per-route checks have nothing to ask",
    );
  });

  it("resource routes answer 404 and never 403 for a non-member", () => {
    // A 403 would confirm that the ticket or page exists; the message has to
    // match the not-found message too, which is asserted in project-access.test.
    const helper = readFileSync(join(here, "project-guard.ts"), "utf8");
    assert.match(helper, /NOT_FOUND/);
    assert.ok(
      !/,\s*403\s*\)/.test(helper),
      "membership denial must not use 403",
    );
  });
});
