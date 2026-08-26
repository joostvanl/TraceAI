import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_BUSY_RETRY_CAP_MS,
  AGENT_BUSY_RETRY_MS,
  AGENT_BUSY_RETRY_WINDOW_MS,
  CursorCloudAgentClient,
  agentBusyRetryDelayMs,
  cloudNudgeSkipComment,
  cloudNudgeSkipReason,
  nudgeClaimedCloudAgent,
  scheduleClaimedCloudNudges,
} from "./cursor-cloud-agent.js";
import type { Ticket } from "./types.js";

function ticket(overrides: Partial<Ticket["fields"]> & { slug?: string } = {}): Ticket {
  const { slug, ...fields } = overrides;
  return {
    id: "1",
    slug: slug ?? "sample",
    contentType: "ticket",
    status: "published",
    locale: "en-US",
    publishedAt: null,
    createdAt: "",
    updatedAt: "",
    fields: {
      title: "Sample",
      project: "traceai",
      workflow: "wf",
      stage: "todo",
      ticket_key: "TRA-1",
      claimed_agent_id: "bc-cloud-1",
      ...fields,
    },
  };
}

describe("nudgeClaimedCloudAgent", () => {
  it("does not call Cursor for empty or non-bc claims", async () => {
    const calls: string[] = [];
    const client = {
      followUp: async (id: string) => {
        calls.push(id);
        return { ok: true, status: 201, busy: false };
      },
    };
    assert.deepEqual(
      await nudgeClaimedCloudAgent(ticket({ claimed_agent_id: "" }), "approved", client),
      {
        attempted: false,
        calls: 0,
        busy: false,
        status: 0,
        agentId: "",
        prompt: "",
      },
    );
    assert.deepEqual(
      await nudgeClaimedCloudAgent(
        ticket({ claimed_agent_id: "agent-local" }),
        "approved",
        client,
      ),
      {
        attempted: false,
        calls: 0,
        busy: false,
        status: 0,
        agentId: "",
        prompt: "",
      },
    );
    assert.equal(calls.length, 0);
  });

  it("sends the locked prompt once on success", async () => {
    const prompts: string[] = [];
    const client = {
      followUp: async (_id: string, prompt: string) => {
        prompts.push(prompt);
        return { ok: true, status: 201, busy: false };
      },
    };
    const result = await nudgeClaimedCloudAgent(
      ticket({ claimed_agent_id: "bc-abc" }),
      "rejected",
      client,
    );
    assert.equal(result.calls, 1);
    assert.equal(result.busy, false);
    assert.match(prompts[0] ?? "", /expected_review_state=rejected/);
  });

  it("returns busy after one agent_busy POST without sleeping", async () => {
    const client = {
      followUp: async () => ({ ok: false, status: 409, busy: true }),
    };
    const result = await nudgeClaimedCloudAgent(ticket(), "approved", client);
    assert.equal(result.attempted, true);
    assert.equal(result.calls, 1);
    assert.equal(result.busy, true);
    assert.equal(result.status, 409);
    assert.equal(result.agentId, "bc-cloud-1");
  });

  it("does not throw on Cursor 500 and does not report busy", async () => {
    const client = {
      followUp: async () => ({ ok: false, status: 500, busy: false }),
    };
    const result = await nudgeClaimedCloudAgent(ticket(), "approved", client, {
      log: () => {},
    });
    assert.equal(result.attempted, true);
    assert.equal(result.calls, 1);
    assert.equal(result.busy, false);
    assert.equal(result.status, 500);
  });
});

describe("scheduleClaimedCloudNudges", () => {
  it("does not block the caller (schedule, not await)", () => {
    const order: string[] = [];
    const scheduled: Array<() => void> = [];
    scheduleClaimedCloudNudges(
      [ticket()],
      "approved",
      {
        followUp: async () => {
          order.push("follow");
          return { ok: true, status: 201, busy: false };
        },
      },
      (fn) => {
        order.push("schedule");
        scheduled.push(fn);
      },
    );
    assert.deepEqual(order, ["schedule"]);
    assert.equal(scheduled.length, 1);
  });

  it("skips when there is no client", () => {
    let scheduled = 0;
    scheduleClaimedCloudNudges([ticket()], "approved", null, () => {
      scheduled += 1;
    });
    assert.equal(scheduled, 0);
  });

  it("reports busy to onBusy after the scheduled job runs", async () => {
    const scheduled: Array<() => void> = [];
    const busy: string[] = [];
    scheduleClaimedCloudNudges(
      [ticket()],
      "approved",
      {
        followUp: async () => ({ ok: false, status: 409, busy: true }),
      },
      (fn) => scheduled.push(fn),
      (t) => {
        busy.push(t.slug);
      },
    );
    assert.equal(busy.length, 0);
    scheduled[0]!();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(busy, ["sample"]);
  });

  it("does not call onBusy for a non-busy Cursor error", async () => {
    const scheduled: Array<() => void> = [];
    let onBusy = 0;
    scheduleClaimedCloudNudges(
      [ticket()],
      "approved",
      {
        followUp: async () => ({ ok: false, status: 500, busy: false }),
      },
      (fn) => scheduled.push(fn),
      () => {
        onBusy += 1;
      },
    );
    scheduled[0]!();
    await new Promise((r) => setImmediate(r));
    assert.equal(onBusy, 0);
  });
});

describe("busy retry helpers", () => {
  it("backs off 30s → 60s → cap 120s", () => {
    assert.equal(agentBusyRetryDelayMs(1), AGENT_BUSY_RETRY_MS);
    assert.equal(agentBusyRetryDelayMs(2), 60_000);
    assert.equal(agentBusyRetryDelayMs(3), AGENT_BUSY_RETRY_CAP_MS);
    assert.equal(agentBusyRetryDelayMs(4), AGENT_BUSY_RETRY_CAP_MS);
  });

  it("keeps a 30-minute retry window", () => {
    assert.equal(AGENT_BUSY_RETRY_WINDOW_MS, 30 * 60 * 1000);
  });

  it("names slug, key, claim, attempts, and reason in the skip comment", () => {
    const body = cloudNudgeSkipComment({
      ticketKey: "TRA-1",
      slug: "sample",
      verdict: "approved",
      agentId: "bc-cloud-1",
      attempts: 8,
      reason: cloudNudgeSkipReason({ kind: "window_elapsed" }),
    });
    assert.match(body, /TRA-1/);
    assert.match(body, /sample/);
    assert.match(body, /bc-cloud-1/);
    assert.match(body, /8 attempt/);
    assert.match(body, /agent_busy/);
    assert.match(body, /approved/);
  });
});

describe("CursorCloudAgentClient", () => {
  it("fromEnv is null without CURSOR_API_KEY", () => {
    assert.equal(CursorCloudAgentClient.fromEnv({}), null);
  });

  it("POSTs Basic auth and prompt.text", async () => {
    const seen: Array<{ url: string; auth: string; body: string }> = [];
    const fetchImpl: typeof fetch = (async (input, init) => {
      seen.push({
        url: String(input),
        auth: String((init?.headers as Record<string, string>)?.Authorization),
        body: String(init?.body),
      });
      return new Response("{}", { status: 201 });
    }) as typeof fetch;
    const client = new CursorCloudAgentClient("test-key", fetchImpl);
    const result = await client.followUp("bc-1", "hello");
    assert.equal(result.ok, true);
    assert.match(seen[0]?.url ?? "", /\/bc-1\/runs$/);
    assert.match(seen[0]?.auth ?? "", /^Basic /);
    assert.match(seen[0]?.body ?? "", /"text":"hello"/);
  });
});
