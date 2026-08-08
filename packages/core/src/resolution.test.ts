import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STAGES,
  isTicketResolution,
  parseWorkflowDocument,
  TICKET_RESOLUTIONS,
  validateTransitionResolution,
  type WorkflowStage,
} from "./types.js";

const review = DEFAULT_STAGES.find((s) => s.key === "review")!;
const done = DEFAULT_STAGES.find((s) => s.key === "done")!;

describe("TICKET_RESOLUTIONS", () => {
  it("accepts allowlisted values only", () => {
    for (const value of TICKET_RESOLUTIONS) {
      assert.equal(isTicketResolution(value), true);
    }
    assert.equal(isTicketResolution("shipped"), false);
    assert.equal(isTicketResolution(""), false);
    assert.equal(isTicketResolution(null), false);
  });
});

describe("validateTransitionResolution", () => {
  it("requires resolution when entering a flagged stage", () => {
    const errors = validateTransitionResolution({
      fromStage: review,
      toStage: done,
    });
    assert.ok(errors.some((e) => e.includes("resolution is required")));
  });

  it("rejects invalid resolution when the flag is on", () => {
    const errors = validateTransitionResolution({
      fromStage: review,
      toStage: done,
      resolution: "shipped",
    });
    assert.ok(errors.some((e) => e.includes("must be one of")));
  });

  it("accepts a valid resolution when the flag is on", () => {
    const errors = validateTransitionResolution({
      fromStage: review,
      toStage: done,
      resolution: "completed",
    });
    assert.deepEqual(errors, []);
  });

  it("does not require resolution when the stage flag is off", () => {
    const plainDone: WorkflowStage = {
      key: "done",
      name: "Done",
      transitions: [],
      agent: { require_resolution_on_enter: false },
    };
    const errors = validateTransitionResolution({
      fromStage: review,
      toStage: plainDone,
    });
    assert.deepEqual(errors, []);
  });

  it("still rejects invalid resolution when provided without the flag", () => {
    const plainDone: WorkflowStage = {
      key: "done",
      name: "Done",
      transitions: [],
    };
    const errors = validateTransitionResolution({
      fromStage: review,
      toStage: plainDone,
      resolution: "nope",
    });
    assert.ok(errors.some((e) => e.includes("must be one of")));
  });
});

describe("parseWorkflowDocument resolution flag", () => {
  it("preserves require_resolution_on_enter on stages", () => {
    const doc = parseWorkflowDocument(
      JSON.stringify({
        version: 2,
        agent_policy: { summary: "x" },
        stages: [
          {
            key: "done",
            name: "Done",
            transitions: [],
            agent: { require_resolution_on_enter: true },
          },
        ],
      }),
    );
    assert.equal(doc.stages[0]?.agent?.require_resolution_on_enter, true);
  });

  it("defaults enable resolution on the product Done stage", () => {
    assert.equal(done.agent?.require_resolution_on_enter, true);
  });
});
