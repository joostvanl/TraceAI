import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentToStageRecordFields,
  formatLineList,
  parseLineList,
  parseOptionalBoolean,
  stageRecordToAgent,
} from "./workflow-stage-fields.js";

const stages = [
  { slug: "story-stage-todo", fields: { key: "todo" } },
  { slug: "story-stage-review", fields: { key: "review" } },
  { slug: "story-stage-done", fields: { key: "done" } },
];

describe("workflow-stage-fields", () => {
  it("parses line lists and treats empty as missing", () => {
    assert.deepEqual(parseLineList("Deze stap\nDoel (kort)"), [
      "Deze stap",
      "Doel (kort)",
    ]);
    assert.equal(parseLineList(""), undefined);
    assert.equal(parseLineList("  \n  "), undefined);
    assert.equal(formatLineList(["Deze stap", "Doel (kort)"]), "Deze stap\nDoel (kort)");
  });

  it("unpacks a JSON string array stored as one textarea line", () => {
    assert.deepEqual(parseLineList('["## Pull Request","## Testverslag"]'), [
      "## Pull Request",
      "## Testverslag",
    ]);
    assert.deepEqual(parseLineList("## Reden"), ["## Reden"]);
    assert.deepEqual(parseLineList('["## Reden"]'), ["## Reden"]);
    assert.deepEqual(parseLineList("[not-json"), ["[not-json"]);
  });

  it("parses optional booleans", () => {
    assert.equal(parseOptionalBoolean(true), true);
    assert.equal(parseOptionalBoolean("true"), true);
    assert.equal(parseOptionalBoolean(false), false);
    assert.equal(parseOptionalBoolean(""), undefined);
  });

  it("round-trips every agent field including gate relations", () => {
    const agent = {
      purpose: "Judge playbook",
      on_enter: ["Read the ticket"],
      on_exit: ["Leave a verdict"],
      require_comment_on_enter: true,
      require_comment_on_exit: true,
      require_comment_sections_on_enter: ["Deze stap"],
      require_comment_sections_on_exit: ["Doel (kort)"],
      require_comment_sections_on_reject: ["## Reden"],
      require_comment_sections_on_dismiss: ["## Reden"],
      comment_template: "## Deze stap\n",
      require_resolution_on_enter: true,
      require_human_approval_on_exit: true,
      human_approve_to: "todo",
      human_dismiss_to: "done",
      human_reject_to: ["review", "done"],
    };
    const fields = agentToStageRecordFields(agent, stages);
    assert.equal(fields.human_approve_to, "story-stage-todo");
    assert.equal(fields.human_dismiss_to, "story-stage-done");
    assert.deepEqual(fields.human_reject_to, [
      "story-stage-review",
      "story-stage-done",
    ]);
    const loaded = stageRecordToAgent(fields, stages);
    assert.deepEqual(loaded, {
      ...agent,
      comment_template: "## Deze stap",
    });
  });

  it("treats missing fields as off", () => {
    assert.equal(stageRecordToAgent({}, stages), undefined);
    assert.equal(
      stageRecordToAgent(
        {
          purpose: "",
          on_enter: "",
          require_comment_on_enter: false,
          human_approve_to: "",
          human_reject_to: [],
        },
        stages,
      ),
      undefined,
    );
  });

  it("resolves gate targets from stage slugs or objects", () => {
    const loaded = stageRecordToAgent(
      {
        require_human_approval_on_exit: true,
        human_approve_to: { slug: "story-stage-todo" },
        human_dismiss_to: "story-stage-done",
        human_reject_to: ["story-stage-review", { slug: "story-stage-done" }],
      },
      stages,
    );
    assert.equal(loaded?.human_approve_to, "todo");
    assert.equal(loaded?.human_dismiss_to, "done");
    assert.deepEqual(loaded?.human_reject_to, ["review", "done"]);
  });
});
