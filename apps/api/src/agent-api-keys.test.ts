import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "@traceai/auth";
import type { Ticket } from "@traceai/core";
import {
  resolveClaimerCursorApiKey,
  listedAgentApiProviders,
} from "./agent-api-keys.js";

function ticket(claimer?: string): Pick<Ticket, "fields"> {
  return {
    fields: {
      title: "t",
      project: "p",
      workflow: "w",
      stage: "todo",
      claimed_agent_id: "bc-1",
      claimed_by_user_id: claimer,
    },
  };
}

describe("resolveClaimerCursorApiKey", () => {
  it("skips missing claimer, missing key, and decrypt failure; ignores CURSOR_API_KEY", () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-claimer-key-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    try {
      const secret = "enc-secret";
      const owner = store.createUser({ email: "a@x", name: "A" });
      const other = store.createUser({ email: "b@x", name: "B" });
      store.putAgentApiKey({
        userId: other.id,
        provider: "cursor",
        apiKey: "key_only_B_zzzz",
        secret,
      });
      const env = {
        TRACEAI_SESSION_SECRET: secret,
        CURSOR_API_KEY: "env-must-not-be-used",
      };

      assert.equal(
        resolveClaimerCursorApiKey(store, ticket(""), env).ok,
        false,
      );
      assert.deepEqual(
        resolveClaimerCursorApiKey(store, ticket(owner.id), env),
        { ok: false, reason: "no_key" },
      );

      const claimerNoKeyUsesFallback = resolveClaimerCursorApiKey(
        store,
        ticket(owner.id),
        env,
        other.id,
      );
      assert.deepEqual(claimerNoKeyUsesFallback, {
        ok: true,
        apiKey: "key_only_B_zzzz",
      });

      store.putAgentApiKey({
        userId: owner.id,
        provider: "cursor",
        apiKey: "key_owner_AAAA",
        secret,
      });
      const hit = resolveClaimerCursorApiKey(store, ticket(owner.id), env);
      assert.deepEqual(hit, { ok: true, apiKey: "key_owner_AAAA" });

      const wrongSecret = resolveClaimerCursorApiKey(store, ticket(owner.id), {
        TRACEAI_SESSION_SECRET: "different-secret",
        CURSOR_API_KEY: "env-must-not-be-used",
      });
      assert.deepEqual(wrongSecret, { ok: false, reason: "decrypt_failed" });

      const listed = listedAgentApiProviders(store, owner.id);
      assert.equal(listed.find((p) => p.provider === "cursor")?.last4, "AAAA");
      assert.equal(listed.find((p) => p.provider === "claude_code")?.configured, false);
      assert.equal(listed.find((p) => p.provider === "codex")?.configured, false);

      const viaFallback = resolveClaimerCursorApiKey(
        store,
        ticket(""),
        env,
        other.id,
      );
      assert.deepEqual(viaFallback, { ok: true, apiKey: "key_only_B_zzzz" });

      const claimerWins = resolveClaimerCursorApiKey(
        store,
        ticket(owner.id),
        env,
        other.id,
      );
      assert.deepEqual(claimerWins, { ok: true, apiKey: "key_owner_AAAA" });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
