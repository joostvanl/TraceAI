import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  UNMAPPED_STAGE_KEY,
  editorWorkflowSlugForRequest,
  isProjectWorkflow,
  isTicketWorkflowReassignable,
  nextColumnSortOrder,
  remapStageForBoard,
  ticketBelongsOnBoard,
  workflowReassignAuditComment,
} from "./board-workflow.js";

const owned = ["traceai-default", "standard-worker"];

describe("ticketBelongsOnBoard", () => {
  it("keeps exact pins on a named board", () => {
    assert.equal(
      ticketBelongsOnBoard({
        ticketWorkflow: "standard-worker",
        selectedWorkflow: "standard-worker",
        defaultWorkflow: "traceai-default",
        projectWorkflowSlugs: owned,
      }),
      true,
    );
    assert.equal(
      ticketBelongsOnBoard({
        ticketWorkflow: "traceai-default",
        selectedWorkflow: "standard-worker",
        defaultWorkflow: "traceai-default",
        projectWorkflowSlugs: owned,
      }),
      false,
    );
  });

  it("shows wees-pins only on the default board", () => {
    const wees = ticketBelongsOnBoard({
      ticketWorkflow: "traceai-product-development",
      selectedWorkflow: "traceai-default",
      defaultWorkflow: "traceai-default",
      projectWorkflowSlugs: owned,
    });
    assert.equal(wees, true);
    assert.equal(
      ticketBelongsOnBoard({
        ticketWorkflow: "traceai-product-development",
        selectedWorkflow: "standard-worker",
        defaultWorkflow: "traceai-default",
        projectWorkflowSlugs: owned,
      }),
      false,
    );
  });

  it("treats empty pin as wees on the default board", () => {
    assert.equal(
      ticketBelongsOnBoard({
        ticketWorkflow: "",
        selectedWorkflow: "traceai-default",
        defaultWorkflow: "traceai-default",
        projectWorkflowSlugs: owned,
      }),
      true,
    );
  });
});

describe("remapStageForBoard", () => {
  it("keeps live keys and remaps unknown to overflow", () => {
    assert.equal(remapStageForBoard("backlog", ["backlog", "todo"]), "backlog");
    assert.equal(
      remapStageForBoard("gone", ["backlog", "todo"]),
      UNMAPPED_STAGE_KEY,
    );
  });
});

describe("isProjectWorkflow", () => {
  it("allows the default even when it is missing from the live list", () => {
    assert.equal(
      isProjectWorkflow("traceai-default", "traceai-default", ["standard-worker"]),
      true,
    );
  });

  it("rejects a dead slug that is not the default", () => {
    assert.equal(
      isProjectWorkflow(
        "traceai-product-development",
        "traceai-default",
        owned,
      ),
      false,
    );
  });
});

describe("isTicketWorkflowReassignable (TRA-95)", () => {
  const base = {
    currentPin: "traceai-default",
    currentStage: "backlog",
    liveFirstStageKey: "backlog",
    defaultWorkflow: "traceai-default",
    projectWorkflowSlugs: owned,
  };

  it("allows a project pin in its live first stage", () => {
    assert.equal(isTicketWorkflowReassignable(base), true);
    assert.equal(
      isTicketWorkflowReassignable({
        ...base,
        currentPin: "standard-worker",
        liveFirstStageKey: "intake",
        currentStage: "intake",
      }),
      true,
    );
  });

  it("rejects any non-first stage", () => {
    assert.equal(
      isTicketWorkflowReassignable({ ...base, currentStage: "todo" }),
      false,
    );
  });

  it("rejects wees-pins (empty, unknown, foreign)", () => {
    assert.equal(
      isTicketWorkflowReassignable({ ...base, currentPin: "" }),
      false,
    );
    assert.equal(
      isTicketWorkflowReassignable({
        ...base,
        currentPin: "traceai-product-development",
      }),
      false,
    );
  });

  it("rejects a pin whose live workflow has no stages", () => {
    assert.equal(
      isTicketWorkflowReassignable({ ...base, liveFirstStageKey: null }),
      false,
    );
  });
});

describe("nextColumnSortOrder", () => {
  it("returns 0 for an empty column and max+1 otherwise", () => {
    assert.equal(nextColumnSortOrder([]), 0);
    assert.equal(nextColumnSortOrder([0, 2, null, undefined]), 3);
  });
});

describe("workflowReassignAuditComment", () => {
  it("is a one-line old → new label", () => {
    assert.equal(
      workflowReassignAuditComment("Standard Worker", "TraceAI Story"),
      "Workflow: Standard Worker → TraceAI Story",
    );
  });
});

describe("editorWorkflowSlugForRequest", () => {
  it("E1: omitted query loads the default", () => {
    assert.equal(
      editorWorkflowSlugForRequest({
        requested: undefined,
        defaultWorkflow: "traceai-default",
        projectWorkflowSlugs: owned,
      }),
      "traceai-default",
    );
  });

  it("E2/E3: foreign or unknown query is null (404)", () => {
    assert.equal(
      editorWorkflowSlugForRequest({
        requested: "beta-standard-worker",
        defaultWorkflow: "traceai-default",
        projectWorkflowSlugs: owned,
      }),
      null,
    );
    assert.equal(
      editorWorkflowSlugForRequest({
        requested: "does-not-exist",
        defaultWorkflow: "traceai-default",
        projectWorkflowSlugs: owned,
      }),
      null,
    );
  });

  it("loads a named own workflow", () => {
    assert.equal(
      editorWorkflowSlugForRequest({
        requested: "standard-worker",
        defaultWorkflow: "traceai-default",
        projectWorkflowSlugs: owned,
      }),
      "standard-worker",
    );
  });
});
