import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, generateRawToken, hashToken, hasScope } from "./index.js";

describe("auth crypto", () => {
  it("hashes deterministically", () => {
    const token = generateRawToken();
    assert.equal(hashToken(token), hashToken(token));
    assert.notEqual(hashToken(token), hashToken(generateRawToken()));
  });

  it("checks scopes with admin bypass", () => {
    assert.equal(hasScope(["tickets:read"], "tickets:read"), true);
    assert.equal(hasScope(["tickets:read"], "tickets:write"), false);
    assert.equal(hasScope(["admin"], "tickets:write"), true);
  });
});

describe("AuthStore", () => {
  it("creates user/token and authenticates", () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-auth-"));
    const store = new AuthStore(join(dir, "test.sqlite"));
    try {
      const user = store.createUser({
        email: "agent@example.com",
        name: "Agent One",
      });
      const created = store.createToken({
        userId: user.id,
        name: "cursor",
      });
      assert.match(created.token, /^trc_/);
      const auth = store.authenticate(created.token);
      assert.ok(auth);
      assert.equal(auth.user.email, "agent@example.com");
      store.revokeToken(created.id);
      assert.equal(store.authenticate(created.token), null);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
