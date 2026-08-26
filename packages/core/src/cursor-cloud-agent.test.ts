import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_BUSY_RETRY_MS,
  CursorCloudAgentClient,
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
      { attempted: false, calls: 0 },
    );
    assert.deepEqual(
      await nudgeClaimedCloudAgent(
        ticket({ claimed_agent_id: "agent-local" }),
        "approved",
        client,
      ),
      { attempted: false, calls: 0 },
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
    assert.match(prompts[0] ?? "", /expected_review_state=rejected/);
  });

  it("retries once after agent_busy then succeeds", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const client = {
      followUp: async () => {
        n += 1;
        if (n === 1) return { ok: false, status: 409, busy: true };
        return { ok: true, status: 201, busy: false };
      },
    };
    const result = await nudgeClaimedCloudAgent(
      ticket(),
      "approved",
      client,
      { sleep: async (ms) => { sleeps.push(ms); } },
    );
    assert.equal(result.calls, 2);
    assert.deepEqual(sleeps, [AGENT_BUSY_RETRY_MS]);
  });

  it("does not throw on Cursor 500", async () => {
    const client = {
      followUp: async () => ({ ok: false, status: 500, busy: false }),
    };
    const result = await nudgeClaimedCloudAgent(ticket(), "approved", client, {
      log: () => {},
    });
    assert.equal(result.attempted, true);
    assert.equal(result.calls, 1);
  });

  it("does not throw when busy twice", async () => {
    const client = {
      followUp: async () => ({ ok: false, status: 409, busy: true }),
    };
    const result = await nudgeClaimedCloudAgent(ticket(), "dismissed", client, {
      sleep: async () => {},
      log: () => {},
    });
    assert.equal(result.calls, 2);
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
