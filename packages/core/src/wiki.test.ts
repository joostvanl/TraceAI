import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STAGES,
  parseWorkflowDocument,
  validateTransitionComment,
  type WorkflowAgentPolicy,
  type WorkflowStage,
} from "./types.js";

const review = DEFAULT_STAGES.find((s) => s.key === "review")!;
const done = DEFAULT_STAGES.find((s) => s.key === "done")!;
const inProgress = DEFAULT_STAGES.find((s) => s.key === "in_progress")!;

const policy: WorkflowAgentPolicy = {
  summary: "x",
  ticket_description: [],
  on_every_transition: ["comment"],
};

describe("wiki DoD gate (## Wiki on enter done)", () => {
  it("defaults require ## Wiki when entering done", () => {
    assert.deepEqual(done.agent?.require_comment_sections_on_enter, [
      "## Wiki",
    ]);
  });

  it("rejects review→done without ## Wiki", () => {
    const errors = validateTransitionComment({
      fromStage: review,
      toStage: done,
      policy,
      comment:
        "## Vorige stap\nReviewed.\n\n## Deze stap\nAccepted.\n\n## Wiki\n",
    });
    // Heading present is enough for section check; empty body under heading is OK in MVP
    // But if heading missing entirely:
    const missing = validateTransitionComment({
      fromStage: review,
      toStage: done,
      policy,
      comment: "## Vorige stap\nReviewed.\n\n## Deze stap\nAccepted.",
    });
    assert.ok(missing.some((e) => e.includes("## Wiki")));
    assert.ok(!errors.some((e) => e.includes("## Wiki")));
  });

  it("allows review→in_progress without ## Wiki", () => {
    const errors = validateTransitionComment({
      fromStage: review,
      toStage: inProgress,
      policy,
      comment:
        "## Vorige stap\nReview found bugs.\n\n## Deze stap\nBack to implement fixes.",
    });
    assert.ok(!errors.some((e) => e.includes("## Wiki")));
  });
});

describe("require_comment_sections_on_exit", () => {
  it("enforces exit sections when leaving a flagged stage", () => {
    const from: WorkflowStage = {
      key: "review",
      name: "Review",
      transitions: ["done"],
      agent: { require_comment_sections_on_exit: ["## Wiki"] },
    };
    const to: WorkflowStage = { key: "done", name: "Done", transitions: [] };
    const missing = validateTransitionComment({
      fromStage: from,
      toStage: to,
      policy,
      comment: "## Vorige stap\nA.\n\n## Deze stap\nB.",
    });
    assert.ok(missing.some((e) => e.includes('Leaving "review"')));
    const ok = validateTransitionComment({
      fromStage: from,
      toStage: to,
      policy,
      comment: "## Vorige stap\nA.\n\n## Deze stap\nB.\n\n## Wiki\nhome",
    });
    assert.ok(!ok.some((e) => e.includes("## Wiki")));
  });

  it("parses require_comment_sections_on_exit from workflow JSON", () => {
    const doc = parseWorkflowDocument(
      JSON.stringify({
        version: 2,
        agent_policy: { summary: "x" },
        stages: [
          {
            key: "review",
            name: "Review",
            transitions: ["done"],
            agent: { require_comment_sections_on_exit: ["## Wiki"] },
          },
        ],
      }),
    );
    assert.deepEqual(doc.stages[0]?.agent?.require_comment_sections_on_exit, [
      "## Wiki",
    ]);
  });
});
