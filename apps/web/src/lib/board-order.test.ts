import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupByStage, moveItem } from "./board-order.js";

describe("moveItem", () => {
  it("moves an item to a new index", () => {
    assert.deepEqual(moveItem(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
    assert.deepEqual(moveItem(["a", "b", "c"], 0, 2), ["b", "c", "a"]);
  });

  it("is a no-op for identical or out-of-range indexes", () => {
    const list = ["a", "b"];
    assert.equal(moveItem(list, 1, 1), list);
    assert.equal(moveItem(list, -1, 0), list);
  });
});

describe("groupByStage first-column sortOrder", () => {
  it("sorts the reorderable stage by sortOrder", () => {
    const stages = [{ key: "backlog" }, { key: "todo" }];
    const tickets = [
      { slug: "c", stage: "backlog", sortOrder: 2 },
      { slug: "a", stage: "backlog", sortOrder: 0 },
      { slug: "b", stage: "backlog", sortOrder: 1 },
      { slug: "z", stage: "todo", sortOrder: 9 },
    ];
    const grouped = groupByStage(stages, tickets, "backlog");
    assert.deepEqual(
      grouped.backlog?.map((t) => t.slug),
      ["a", "b", "c"],
    );
    assert.deepEqual(
      grouped.todo?.map((t) => t.slug),
      ["z"],
    );
  });
});
