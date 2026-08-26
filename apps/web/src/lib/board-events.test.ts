import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyBoardTicketEvent, type BoardTicketEvent } from "./board-events.js";
import type { BoardTicket } from "./board-events.js";

const owned = ["traceai-default", "standard-worker"];

const defaultBoard = {
  projectSlug: "traceai",
  selectedWorkflow: "traceai-default",
  defaultWorkflow: "traceai-default",
  projectWorkflowSlugs: owned,
};

const namedBoard = {
  projectSlug: "traceai",
  selectedWorkflow: "standard-worker",
  defaultWorkflow: "traceai-default",
  projectWorkflowSlugs: owned,
};

function created(
  workflow: string,
  slug = "new-ticket",
): BoardTicketEvent {
  return {
    type: "ticket.created",
    project: "traceai",
    ticket: {
      slug,
      ticket_key: "TRA-99",
      title: "New",
      stage: "backlog",
      project: "traceai",
      workflow,
    },
    at: "2026-08-20T12:00:00.000Z",
  };
}

describe("applyBoardTicketEvent", () => {
  it("S1: ignores created tickets on another workflow of a named board", () => {
    const prev: BoardTicket[] = [];
    const next = applyBoardTicketEvent(
      prev,
      created("traceai-default"),
      namedBoard,
    );
    assert.equal(next.length, 0);
  });

  it("S2: adds a created ticket of the selected workflow", () => {
    const next = applyBoardTicketEvent(
      [],
      created("standard-worker"),
      namedBoard,
    );
    assert.equal(next[0]?.slug, "new-ticket");
    assert.equal(next[0]?.workflow, "standard-worker");
  });

  it("S3: drops a ticket that transitions onto another workflow", () => {
    const prev: BoardTicket[] = [
      {
        slug: "moved",
        title: "Moved",
        stage: "backlog",
        priority: "medium",
        workflow: "standard-worker",
      },
    ];
    const next = applyBoardTicketEvent(
      prev,
      {
        type: "ticket.transitioned",
        project: "traceai",
        ticket: {
          slug: "moved",
          title: "Moved",
          stage: "todo",
          project: "traceai",
          workflow: "traceai-default",
        },
        at: "2026-08-20T12:00:00.000Z",
      },
      namedBoard,
    );
    assert.equal(next.length, 0);
  });

  it("S4: keeps workflow on the resulting BoardTicket", () => {
    const next = applyBoardTicketEvent(
      [],
      created("standard-worker"),
      namedBoard,
    );
    assert.equal(next[0]?.workflow, "standard-worker");
    assert.equal(next[0]?.orphan, false);
  });

  it("S5: default-board adds a wees-pin created event", () => {
    const next = applyBoardTicketEvent(
      [],
      created("traceai-product-development", "wees"),
      defaultBoard,
    );
    assert.equal(next[0]?.slug, "wees");
    assert.equal(next[0]?.orphan, true);
  });

  it("TRA-112: keeps claimedAgentId from the previous snapshot on SSE merge", () => {
    const prev: BoardTicket[] = [
      {
        slug: "claimed",
        title: "Claimed",
        stage: "in_progress",
        priority: "medium",
        workflow: "standard-worker",
        claimedAgentId: "bc-abcdefghijklmno",
      },
    ];
    const next = applyBoardTicketEvent(
      prev,
      {
        type: "ticket.updated",
        project: "traceai",
        ticket: {
          slug: "claimed",
          title: "Claimed (renamed)",
          stage: "in_progress",
          project: "traceai",
          workflow: "standard-worker",
        },
        at: "2026-08-26T12:00:00.000Z",
      },
      namedBoard,
    );
    assert.equal(next[0]?.claimedAgentId, "bc-abcdefghijklmno");
    assert.equal(next[0]?.title, "Claimed (renamed)");
  });
});
