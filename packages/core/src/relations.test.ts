import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { relationSlug, relationSlugOrEmpty } from "./relations.js";

describe("relationSlug", () => {
  it("accepts plain slug strings", () => {
    assert.equal(relationSlug("traceai"), "traceai");
    assert.equal(relationSlug("  joostvl  "), "joostvl");
  });

  it("accepts object shapes with slug", () => {
    assert.equal(relationSlug({ slug: "traceai" }), "traceai");
    assert.equal(relationSlug({ entry: { slug: "wiki-home" } }), "wiki-home");
  });

  it("returns null for empty / unknown values", () => {
    assert.equal(relationSlug(null), null);
    assert.equal(relationSlug(undefined), null);
    assert.equal(relationSlug(""), null);
    assert.equal(relationSlug("   "), null);
    assert.equal(relationSlug({}), null);
    assert.equal(relationSlug(42), null);
  });
});

describe("relationSlugOrEmpty", () => {
  it("maps missing to empty string", () => {
    assert.equal(relationSlugOrEmpty(null), "");
    assert.equal(relationSlugOrEmpty({ slug: "x" }), "x");
  });
});
