import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STAGES,
  LAST_STAGE_VISIBLE_LIMIT,
  lastStageKey,
  selectTicketsToArchive,
} from "./types.js";

describe("lastStageKey", () => {
  it("returns the last stage key from the workflow definition", () => {
    assert.equal(lastStageKey(DEFAULT_STAGES), "done");
  });

  it("works when the last stage is not named done", () => {
    assert.equal(
      lastStageKey([
        { key: "todo", name: "To do", transitions: ["shipped"] },
        { key: "shipped", name: "Shipped", transitions: [] },
      ]),
      "shipped",
    );
  });

  it("returns null for an empty stages list", () => {
    assert.equal(lastStageKey([]), null);
  });
});

describe("selectTicketsToArchive", () => {
  it("keeps the newest limit tickets and archives older ones", () => {
    const candidates = Array.from({ length: 25 }, (_, i) => ({
      slug: `t-${i}`,
      stage_entered_at: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
    }));
    const archived = selectTicketsToArchive(candidates, 20);
    assert.equal(archived.length, 5);
    assert.deepEqual(archived, ["t-4", "t-3", "t-2", "t-1", "t-0"]);
  });

  it("ignores already-archived tickets when counting the visible limit", () => {
    const candidates = [
      { slug: "old", stage_entered_at: "2026-01-01T00:00:00.000Z", archived_at: "2026-02-01T00:00:00.000Z" },
      ...Array.from({ length: 20 }, (_, i) => ({
        slug: `keep-${i}`,
        stage_entered_at: new Date(Date.UTC(2026, 2, i + 1)).toISOString(),
      })),
      {
        slug: "overflow",
        stage_entered_at: "2026-01-15T00:00:00.000Z",
      },
    ];
    const archived = selectTicketsToArchive(candidates, 20);
    assert.deepEqual(archived, ["overflow"]);
  });

  it("falls back to updated_at when stage_entered_at is missing", () => {
    const archived = selectTicketsToArchive(
      [
        { slug: "a", updated_at: "2026-01-01T00:00:00.000Z" },
        { slug: "b", updated_at: "2026-01-03T00:00:00.000Z" },
        { slug: "c", updated_at: "2026-01-02T00:00:00.000Z" },
      ],
      2,
    );
    assert.deepEqual(archived, ["a"]);
  });

  it("archives nothing when at or under the limit", () => {
    const candidates = Array.from({ length: LAST_STAGE_VISIBLE_LIMIT }, (_, i) => ({
      slug: `t-${i}`,
      stage_entered_at: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
    }));
    assert.deepEqual(selectTicketsToArchive(candidates), []);
  });
});
