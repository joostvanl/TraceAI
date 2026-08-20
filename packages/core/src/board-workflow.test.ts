import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  UNMAPPED_STAGE_KEY,
  editorWorkflowSlugForRequest,
  isProjectWorkflow,
  remapStageForBoard,
  ticketBelongsOnBoard,
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
