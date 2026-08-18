import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allocateUniqueEntrySlug,
  UNIQUE_ENTRY_SLUG_MAX_ATTEMPTS,
  type EntrySlugProber,
} from "./unique-entry-slug.js";

function prober(existing: Set<string>): EntrySlugProber & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getEntryBySlug(_apiId, slug) {
      calls.push(slug);
      return existing.has(slug) ? { slug } : null;
    },
  };
}

describe("allocateUniqueEntrySlug", () => {
  it("returns the base slug when free", async () => {
    const client = prober(new Set());
    const slug = await allocateUniqueEntrySlug(client, "ticket", "Hello World");
    assert.equal(slug, "hello-world");
    assert.deepEqual(client.calls, ["hello-world"]);
  });

  it("suffixes -2 when the base slug already exists", async () => {
    const client = prober(new Set(["hello-world"]));
    const slug = await allocateUniqueEntrySlug(client, "ticket", "Hello World");
    assert.equal(slug, "hello-world-2");
    assert.deepEqual(client.calls, ["hello-world", "hello-world-2"]);
  });

  it("finds a free slug beyond the first 100 colliding entries", async () => {
    // Regression for the old createTicket path: a Set built from limit:100
    // would miss a collision past entry 100 and propose a taken slug.
    const existing = new Set(["shared-title"]);
    for (let i = 2; i <= 120; i++) existing.add(`shared-title-${i}`);
    const client = prober(existing);
    const slug = await allocateUniqueEntrySlug(
      client,
      "ticket",
      "Shared Title",
      150,
    );
    assert.equal(slug, "shared-title-121");
    assert.equal(client.calls.length, 121);
    assert.equal(client.calls[0], "shared-title");
    assert.equal(client.calls.at(-1), "shared-title-121");
  });

  it("throws when the attempt cap is reached", async () => {
    const existing = new Set(["taken"]);
    for (let i = 2; i <= UNIQUE_ENTRY_SLUG_MAX_ATTEMPTS + 1; i++) {
      existing.add(`taken-${i}`);
    }
    const client = prober(existing);
    await assert.rejects(
      () => allocateUniqueEntrySlug(client, "ticket", "taken", 5),
      /after 5 attempts/,
    );
  });
});
