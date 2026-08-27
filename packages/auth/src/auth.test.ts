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

describe("agent API keys", () => {
  it("encrypts at rest and never returns the secret from list/put", () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-auth-"));
    const store = new AuthStore(join(dir, "test.sqlite"));
    try {
      const user = store.createUser({
        email: "owner@example.com",
        name: "Owner",
      });
      const secret = "session-secret-for-aes";
      const put = store.putAgentApiKey({
        userId: user.id,
        provider: "cursor",
        apiKey: "key_abcdefghijklmnopqrstuvwxyz",
        secret,
      });
      assert.equal(put.configured, true);
      assert.equal(put.last4, "wxyz");
      assert.equal(
        JSON.stringify(put).includes("key_abcdefghijklmnopqrstuvwxyz"),
        false,
      );
      const listed = store.listAgentApiKeyMeta(user.id);
      assert.deepEqual(listed, [
        { provider: "cursor", configured: true, last4: "wxyz" },
      ]);
      const record = store.getAgentApiKeyRecord(user.id, "cursor");
      assert.ok(record);
      assert.equal(record.last4, "wxyz");
      assert.ok(!record.ciphertext.equals(Buffer.from("key_abcdefghijklmnopqrstuvwxyz")));
      const replaced = store.putAgentApiKey({
        userId: user.id,
        provider: "cursor",
        apiKey: "key_REPLACED_9999",
        secret,
      });
      assert.equal(replaced.last4, "9999");
      assert.equal(store.deleteAgentApiKey(user.id, "cursor"), true);
      assert.equal(store.getAgentApiKeyRecord(user.id, "cursor"), null);
      assert.deepEqual(store.listAgentApiKeyMeta(user.id), []);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("default Cursor agent id (TRA-122)", () => {
  it("saves, replaces, and clears a plain-text agent id", () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-auth-"));
    const store = new AuthStore(join(dir, "test.sqlite"));
    try {
      const user = store.createUser({
        email: "owner@example.com",
        name: "Owner",
      });
      assert.equal(store.getDefaultCursorAgentId(user.id), null);
      assert.equal(
        store.setDefaultCursorAgentId(user.id, "bc-aaaa"),
        "bc-aaaa",
      );
      assert.equal(store.getDefaultCursorAgentId(user.id), "bc-aaaa");
      assert.equal(
        store.setDefaultCursorAgentId(user.id, "  other-agent  "),
        "other-agent",
      );
      assert.equal(store.getDefaultCursorAgentId(user.id), "other-agent");
      assert.equal(store.setDefaultCursorAgentId(user.id, "  "), null);
      assert.equal(store.getDefaultCursorAgentId(user.id), null);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AES-256-GCM agent key crypto", () => {
  it("round-trips and fails closed on tamper", async () => {
    const { decryptAgentApiKey, encryptAgentApiKey } = await import("./crypto.js");
    const secret = "unit-test-secret";
    const { ciphertext, nonce } = encryptAgentApiKey("plain-key-value", secret);
    assert.equal(decryptAgentApiKey(ciphertext, nonce, secret), "plain-key-value");
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    assert.throws(() => decryptAgentApiKey(ciphertext, nonce, secret));
  });
});
