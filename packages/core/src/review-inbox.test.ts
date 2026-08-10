import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReviewInboxItems } from "./review-inbox.js";
import type { Ticket, WorkflowStage } from "./types.js";

function ticket(
  slug: string,
  fields: Partial<Ticket["fields"]> & { stage: string },
): Ticket {
  return {
    id: slug,
    slug,
    contentType: "ticket",
    status: "published",
    locale: "en-US",
    publishedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    fields: {
      title: slug,
      description: "x",
      project: "traceai",
      workflow: "wf",
      priority: "medium",
      created_by: "agent",
      stage_entered_at: "2026-01-02T00:00:00.000Z",
      ...fields,
    },
  };
}

const stages: WorkflowStage[] = [
  {
    key: "in_refinement",
    name: "In Refinement",
    transitions: ["todo"],
    agent: {
      purpose: "refine",
      require_human_approval_on_exit: true,
      human_approve_to: "todo",
      human_reject_to: ["backlog"],
    },
  },
  {
    key: "todo",
    name: "To do",
    transitions: ["in_progress"],
  },
  {
    key: "review",
    name: "Review",
    transitions: ["done"],
    agent: {
      purpose: "review",
      require_human_approval_on_exit: true,
      human_approve_to: "done",
      human_reject_to: ["todo"],
    },
  },
];

describe("buildReviewInboxItems", () => {
  it("splits gated tickets into awaiting verdict vs agent", () => {
    const items = buildReviewInboxItems(
      [
        ticket("a", { stage: "in_refinement" }),
        ticket("b", {
          stage: "review",
          review_state: "approved",
          stage_entered_at: "2026-01-03T00:00:00.000Z",
        }),
        ticket("c", { stage: "todo" }),
      ],
      stages,
      "traceai",
    );
    assert.equal(items.length, 2);
    assert.equal(items[0]!.ticket.slug, "b");
    assert.equal(items[0]!.awaiting, "agent");
    assert.equal(items[1]!.ticket.slug, "a");
    assert.equal(items[1]!.awaiting, "verdict");
  });
});
