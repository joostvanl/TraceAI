import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConflictError } from "./trace-errors.js";
import {
  assertUniqueProjectAgentDisplayName,
  displayNameForCursorAgentId,
  projectAgentNameMap,
  projectAgentSlug,
  trimDisplayName,
} from "./project-agent.js";

const henk = {
  cursor_agent_id: "bc-old-id",
  display_name: "Henk",
};

describe("project_agent uniqueness (TRA-127)", () => {
  it("rejects a second non-empty name in the same project case-insensitively", () => {
    assert.throws(
      () =>
        assertUniqueProjectAgentDisplayName({
          agents: [henk],
          cursorAgentId: "bc-new-id",
          displayName: " henk ",
        }),
      (err: unknown) =>
        err instanceof ConflictError &&
        err.status === 409 &&
        err.code === "AGENT_DISPLAY_NAME_CONFLICT",
    );
  });

  it("allows the same name when writing the existing cursor_agent_id (upsert)", () => {
    assert.doesNotThrow(() =>
      assertUniqueProjectAgentDisplayName({
        agents: [henk],
        cursorAgentId: "bc-old-id",
        displayName: "Henk",
      }),
    );
  });

  it("allows empty display_name even when Henk already exists", () => {
    assert.doesNotThrow(() =>
      assertUniqueProjectAgentDisplayName({
        agents: [henk],
        cursorAgentId: "bc-new-id",
        displayName: "  ",
      }),
    );
  });

  it("does not treat a new id as inheriting the old name", () => {
    assert.equal(
      displayNameForCursorAgentId([henk], "bc-new-id"),
      null,
    );
    assert.equal(displayNameForCursorAgentId([henk], "bc-old-id"), "Henk");
  });
});

describe("project_agent helpers (TRA-127)", () => {
  it("trims display names and treats non-strings as empty", () => {
    assert.equal(trimDisplayName("  Henk  "), "Henk");
    assert.equal(trimDisplayName("   "), "");
    assert.equal(trimDisplayName(null), "");
    assert.equal(trimDisplayName(undefined), "");
  });

  it("builds a slug without a double dash", () => {
    const slug = projectAgentSlug("traceai", "bc-abc-1");
    assert.equal(slug, "traceai-agent-bc-abc-1");
    assert.doesNotMatch(slug, /--/);
  });

  it("maps only non-empty names by cursor id", () => {
    const map = projectAgentNameMap([
      henk,
      { cursor_agent_id: "bc-empty", display_name: "  " },
    ]);
    assert.equal(map.get("bc-old-id"), "Henk");
    assert.equal(map.has("bc-empty"), false);
  });
});
