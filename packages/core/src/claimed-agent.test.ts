import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLAIM_TICKET_BEFORE_HUMAN_GATE,
  claimPersistenceFields,
  claimedAgentKind,
  cloudWakeupPrompt,
  parseClaimedAgentId,
} from "./claimed-agent.js";
import { DEFAULT_AGENT_POLICY } from "./types.js";
import { STANDARD_WORKER_WORKFLOW_DOCUMENT } from "./standard-worker-workflow.js";

describe("claimed agent id", () => {
  it("clears empty / whitespace-only values", () => {
    assert.deepEqual(parseClaimedAgentId(""), { ok: true, value: "" });
    assert.deepEqual(parseClaimedAgentId("   "), { ok: true, value: "" });
    assert.deepEqual(parseClaimedAgentId(null), { ok: true, value: "" });
  });

  it("rejects ids with whitespace", () => {
    const result = parseClaimedAgentId("bc-abc def");
    assert.equal(result.ok, false);
  });

  it("accepts bc- and non-bc ids", () => {
    assert.deepEqual(parseClaimedAgentId("bc-abc"), {
      ok: true,
      value: "bc-abc",
    });
    assert.deepEqual(parseClaimedAgentId("agent-local-1"), {
      ok: true,
      value: "agent-local-1",
    });
  });

  it("derives kind from the bc- prefix", () => {
    assert.equal(claimedAgentKind("bc-ad8e"), "cursor_cloud");
    assert.equal(claimedAgentKind("agent-1"), "other");
    assert.equal(claimedAgentKind(""), null);
    assert.equal(claimedAgentKind(null), null);
  });

  it("stores claimer with a claim and clears both when unclaimed", () => {
    assert.deepEqual(claimPersistenceFields("bc-abc", "usr_alice"), {
      claimed_agent_id: "bc-abc",
      claimed_by_user_id: "usr_alice",
    });
    assert.deepEqual(claimPersistenceFields("", "usr_alice"), {
      claimed_agent_id: "",
      claimed_by_user_id: "",
    });
  });
});

describe("cloudWakeupPrompt", () => {
  it("locks expected_stage and expected_review_state", () => {
    const text = cloudWakeupPrompt({
      ticketKey: "TRA-107",
      slug: "cursor-cloud-agent-wake-up-functie",
      verdict: "approved",
      stage: "todo",
    });
    assert.match(text, /TRA-107/);
    assert.match(text, /expected_stage=todo/);
    assert.match(text, /expected_review_state=approved/);
    assert.match(text, /Chat is not a verdict/);
  });
});

describe("agent policy claim-before-gate (TRA-107)", () => {
  it("is in seed and default policy", () => {
    assert.ok(
      DEFAULT_AGENT_POLICY.on_every_transition.includes(
        CLAIM_TICKET_BEFORE_HUMAN_GATE,
      ),
    );
    assert.ok(
      STANDARD_WORKER_WORKFLOW_DOCUMENT.agent_policy.on_every_transition.includes(
        CLAIM_TICKET_BEFORE_HUMAN_GATE,
      ),
    );
  });
});
