import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyClaimedAgentId } from "./copy-claimed-agent-id.ts";

const FULL_ID = "bc-424390ce-761f-4f41-a2fb-b63924218ff9";

describe("copyClaimedAgentId (TRA-125)", () => {
  it("writes the normalized raw id, not a display label", async () => {
    const written: string[] = [];
    const result = await copyClaimedAgentId(`  ${FULL_ID}  `, async (text) => {
      written.push(text);
    });
    assert.equal(result, "copied");
    assert.deepEqual(written, [FULL_ID]);
    assert.doesNotMatch(written[0] ?? "", /Cursor Cloud/);
    assert.doesNotMatch(written[0] ?? "", /…/);
  });

  it("returns empty when there is no id", async () => {
    let called = 0;
    const result = await copyClaimedAgentId("   ", async () => {
      called += 1;
    });
    assert.equal(result, "empty");
    assert.equal(called, 0);
  });

  it("returns failed when writeText throws", async () => {
    const result = await copyClaimedAgentId(FULL_ID, async () => {
      throw new Error("clipboard denied");
    });
    assert.equal(result, "failed");
  });
});
