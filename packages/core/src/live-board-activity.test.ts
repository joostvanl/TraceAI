import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LIVE_BOARD_ACTIVITY_INSTRUCTION,
  appendLiveBoardActivityInstruction,
  isLiveBoardActivityEnabled,
} from "./live-board-activity.js";

describe("live-board-activity (TRA-142)", () => {
  it("only the string true is enabled", () => {
    assert.equal(isLiveBoardActivityEnabled("true"), true);
    assert.equal(isLiveBoardActivityEnabled(" true "), true);
    assert.equal(isLiveBoardActivityEnabled(undefined), false);
    assert.equal(isLiveBoardActivityEnabled(null), false);
    assert.equal(isLiveBoardActivityEnabled(""), false);
    assert.equal(isLiveBoardActivityEnabled("false"), false);
    assert.equal(isLiveBoardActivityEnabled("TRUE"), false);
    assert.equal(isLiveBoardActivityEnabled(true), false);
  });

  it("append is identity when disabled", () => {
    const summary = "Keep tickets thin.";
    assert.equal(appendLiveBoardActivityInstruction(summary, false), summary);
  });

  it("append adds the locked suffix when enabled", () => {
    const summary = "Keep tickets thin.";
    const next = appendLiveBoardActivityInstruction(summary, true);
    assert.equal(next, `${summary}${LIVE_BOARD_ACTIVITY_INSTRUCTION}`);
    assert.match(next, /MUST call set_ticket_activity/);
  });

  it("append is idempotent if the block is already present", () => {
    const once = appendLiveBoardActivityInstruction("Playbook.", true);
    assert.equal(appendLiveBoardActivityInstruction(once, true), once);
  });
});
