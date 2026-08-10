import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, DEFAULT_AGENT_SCOPES } from "@traceai/auth";
import {
  authEmailForUiSlug,
  sanitizeSelfServiceScopes,
} from "./self-service-tokens.js";

describe("self-service tokens helpers", () => {
  it("maps UI slug to a stable AuthStore email", () => {
    assert.equal(
      authEmailForUiSlug("JoostVL"),
      "ui+joostvl@users.traceai.local",
    );
  });

  it("strips admin from self-service scopes", () => {
    assert.deepEqual(sanitizeSelfServiceScopes(null), [
      ...DEFAULT_AGENT_SCOPES,
    ]);
    assert.deepEqual(
      sanitizeSelfServiceScopes(["tickets:read", "admin", "nope"]),
      ["tickets:read"],
    );
    assert.deepEqual(sanitizeSelfServiceScopes(["admin"]), [
      ...DEFAULT_AGENT_SCOPES,
    ]);
  });

  it("provisions AuthStore users by bridge email", () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-self-service-"));
    const store = new AuthStore(join(dir, "test.sqlite"));
    try {
      const email = authEmailForUiSlug("alice");
      assert.equal(store.getUserByEmail(email), null);
      const user = store.createUser({ email, name: "Alice" });
      const token = store.createToken({
        userId: user.id,
        name: "cursor",
        scopes: sanitizeSelfServiceScopes(["admin", "tickets:write"]),
      });
      assert.equal(token.scopes.includes("admin"), false);
      assert.ok(token.scopes.includes("tickets:write"));
      assert.equal(store.listTokens(user.id).length, 1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
