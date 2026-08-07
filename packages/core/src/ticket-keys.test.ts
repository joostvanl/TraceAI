import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveProjectKeyFromSlug,
  formatTicketKey,
  isTicketKeyPattern,
  normalizeProjectKey,
} from "./types.js";

describe("ticket key helpers", () => {
  it("normalizes project keys", () => {
    assert.equal(normalizeProjectKey("tra"), "TRA");
    assert.equal(normalizeProjectKey(" TR-A "), "TRA");
    assert.equal(normalizeProjectKey("x"), null);
    assert.equal(normalizeProjectKey("TOOLONGKEY12"), null);
  });

  it("derives deterministic defaults", () => {
    assert.equal(deriveProjectKeyFromSlug("traceai"), "TRA");
    assert.equal(deriveProjectKeyFromSlug("demo-app"), "DEM");
  });

  it("formats and detects ticket keys", () => {
    assert.equal(formatTicketKey("TRA", 42), "TRA-42");
    assert.equal(isTicketKeyPattern("TRA-42"), true);
    assert.equal(isTicketKeyPattern("tra-42"), true);
    assert.equal(isTicketKeyPattern("ticket-id-toevoegen"), false);
    assert.equal(isTicketKeyPattern("T-1"), false);
  });
});
