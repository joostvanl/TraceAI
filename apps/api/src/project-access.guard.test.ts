import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "app.ts"), "utf8");

/**
 * TRA-81: the membership check lives in middleware precisely so a new route
 * cannot forget it. That only holds while the middleware keeps covering every
 * project-scoped path, so this test fails when one escapes.
 */
describe("project access route coverage (TRA-81)", () => {
  it("G1: every /v1/projects/:slug route is covered by the middleware", () => {
    // Registered routes: app.get("/v1/projects/:slug..."), app.post(...), etc.
    const routes = [
      ...source.matchAll(
        /app\.(get|post|patch|delete)\(\s*\n?\s*"(\/v1\/projects\/[^"]*)"/g,
      ),
    ].map((m) => m[2]);

    // A floor, not an exact count: if the regex ever stops matching, this test
    // would otherwise pass by finding nothing at all.
    assert.ok(
      routes.length >= 5,
      `expected to find the project-scoped routes, found ${routes.length}`,
    );

    const middlewarePatterns = [
      ...source.matchAll(/app\.use\(\s*"(\/v1\/projects\/[^"]*)"/g),
    ].map((m) => m[1]);

    assert.ok(
      middlewarePatterns.includes("/v1/projects/:slug"),
      "the bare /v1/projects/:slug route needs its own middleware registration",
    );
    assert.ok(
      middlewarePatterns.includes("/v1/projects/:slug/*"),
      "sub-routes need the wildcard middleware registration",
    );

    // A route is covered when it is exactly `/v1/projects/:slug` or sits under it.
    const uncovered = routes.filter(
      (route) =>
        route !== "/v1/projects/:slug" &&
        !route.startsWith("/v1/projects/:slug/"),
    );
    assert.deepEqual(
      uncovered,
      [],
      `these project routes are not covered by the access middleware: ${uncovered.join(", ")}`,
    );
  });

  it("G2: creating a project is not behind the membership guard", () => {
    // A new user has no memberships, so POST /v1/projects must stay reachable —
    // it is the only way to gain access in the first place (F2).
    const middlewarePatterns = [
      ...source.matchAll(/app\.use\(\s*"(\/v1\/projects[^"]*)"/g),
    ].map((m) => m[1]);
    assert.ok(
      !middlewarePatterns.includes("/v1/projects"),
      "POST /v1/projects must not be gated by the membership middleware",
    );
    assert.ok(
      !middlewarePatterns.includes("/v1/projects/*"),
      "a /v1/projects/* pattern would also swallow the create route",
    );
  });

  it("the guard uses 404 and never 403 for a non-member", () => {
    const middleware = source.slice(
      source.indexOf("const projectAccessMiddleware"),
      source.indexOf("app.use(\"/v1/projects/:slug\""),
    );
    assert.match(middleware, /NOT_FOUND/);
    // Match a returned status, not the digits — the comment above the 404 in
    // app.ts explains *why* it is not a 403 and would otherwise trip this.
    assert.match(middleware, /,\s*404\s*\)/);
    assert.ok(
      !/,\s*403\s*\)/.test(middleware),
      "a 403 here would confirm that someone else's project exists",
    );
  });
});
