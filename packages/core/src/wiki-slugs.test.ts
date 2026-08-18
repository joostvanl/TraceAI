import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveWikiEntrySlugInProject,
  wikiEntrySlug,
  wikiLogicalSlug,
} from "./wiki-slugs.js";

describe("wikiEntrySlug / wikiLogicalSlug", () => {
  it("round-trips namespaced slugs with URL-safe separator", () => {
    const entry = wikiEntrySlug("acme", "home");
    assert.equal(entry, "acme-wp-home");
    assert.equal(wikiLogicalSlug(entry, "acme"), "home");
    assert.ok(!entry.includes("--"), "Aurora rejects consecutive hyphens");
  });

  it("passes through legacy bare slugs", () => {
    assert.equal(wikiLogicalSlug("home", "traceai"), "home");
  });

  it("does not double-prefix", () => {
    assert.equal(wikiEntrySlug("acme", "acme-wp-home"), "acme-wp-home");
  });

  it("still resolves legacy -- separator", () => {
    assert.equal(wikiLogicalSlug("acme--home", "acme"), "home");
  });
});

describe("resolveWikiEntrySlugInProject", () => {
  const pages = [{ slug: "home" }, { slug: "acme-wp-architecture" }];

  it("resolves exact entry slug", () => {
    assert.equal(
      resolveWikiEntrySlugInProject({
        project: "traceai",
        slugOrLogical: "home",
        pages,
      }),
      "home",
    );
  });

  it("resolves logical slug to namespaced entry", () => {
    assert.equal(
      resolveWikiEntrySlugInProject({
        project: "acme",
        slugOrLogical: "architecture",
        pages,
      }),
      "acme-wp-architecture",
    );
  });

  it("returns null when missing", () => {
    assert.equal(
      resolveWikiEntrySlugInProject({
        project: "acme",
        slugOrLogical: "missing",
        pages,
      }),
      null,
    );
  });
});
