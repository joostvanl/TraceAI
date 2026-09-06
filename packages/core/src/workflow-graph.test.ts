import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ValidationError } from "./trace-errors.js";
import {
  DEFAULT_AGENT_POLICY,
  parseWorkflowDocument,
  serializeWorkflowDocument,
} from "./types.js";
import { getEdgeScopedRules } from "./workflow-editor.js";
import {
  assembleGraphToDocument,
  assertUniqueGraphEdges,
  documentToGraphParts,
  graphPartsSemanticallyEqual,
  parseWorkflowStorageModel,
  slimWorkflowStages,
  wantsFullWorkflowInclude,
} from "./workflow-graph.js";

const fixtureDoc = parseWorkflowDocument(
  serializeWorkflowDocument({
    version: 2,
    agent_policy: {
      ...DEFAULT_AGENT_POLICY,
      require_tokens_used_on_transition: true,
    },
    stages: [
      {
        key: "backlog",
        name: "Backlog",
        transitions: ["refined"],
        agent: {
          purpose: "Parked",
          require_human_approval_on_exit: true,
          human_approve_to: "refined",
          require_tokens_estimate_on_exit_to: ["refined"],
        },
      },
      {
        key: "refined",
        name: "Refined",
        transitions: ["todo", "backlog"],
        agent: {
          purpose: "Judge playbook",
          require_playbook_description_on_exit_to: ["todo"],
        },
      },
      {
        key: "todo",
        name: "To do",
        transitions: [],
      },
    ],
  }),
);

describe("workflow-graph", () => {
  it("treats missing storage_model as legacy_json", () => {
    assert.equal(parseWorkflowStorageModel(undefined), "legacy_json");
    assert.equal(parseWorkflowStorageModel(""), "legacy_json");
    assert.equal(parseWorkflowStorageModel("legacy_json"), "legacy_json");
    assert.equal(parseWorkflowStorageModel("graph"), "graph");
  });

  it("round-trips a document through graph parts", () => {
    const parts = documentToGraphParts(fixtureDoc);
    const assembled = assembleGraphToDocument({
      version: parts.version,
      agent_policy: parts.agent_policy,
      ticket_templates: parts.ticket_templates,
      stages: parts.stages,
      edges: parts.edges,
    });
    assert.equal(graphPartsSemanticallyEqual(fixtureDoc, assembled), true);
    assert.equal(
      getEdgeScopedRules(assembled.stages[0], "refined").require_tokens_estimate,
      true,
    );
    assert.equal(
      getEdgeScopedRules(assembled.stages[1], "todo")
        .require_playbook_description,
      true,
    );
    assert.equal(
      assembled.stages[0].agent?.require_human_approval_on_exit,
      true,
    );
    assert.equal(assembled.stages[0].agent?.human_approve_to, "refined");
    assert.ok(
      !assembled.stages[0].agent?.require_tokens_estimate_on_exit_to ||
        assembled.stages[0].agent.require_tokens_estimate_on_exit_to.includes(
          "refined",
        ),
    );
  });

  it("rejects duplicate edges", () => {
    assert.throws(
      () =>
        assertUniqueGraphEdges([
          {
            from_key: "a",
            to_key: "b",
            require_tokens_estimate: false,
            require_playbook_description: false,
          },
          {
            from_key: "a",
            to_key: "b",
            require_tokens_estimate: true,
            require_playbook_description: false,
          },
        ]),
      ValidationError,
    );
  });

  it("slims stages to key, name, transitions", () => {
    const slim = slimWorkflowStages(fixtureDoc.stages);
    assert.deepEqual(Object.keys(slim[0]).sort(), [
      "key",
      "name",
      "transitions",
    ]);
    assert.equal("agent" in slim[0], false);
    assert.equal(slim[0].key, "backlog");
  });

  it("recognizes include=full", () => {
    assert.equal(wantsFullWorkflowInclude("full"), true);
    assert.equal(wantsFullWorkflowInclude(undefined), false);
    assert.equal(wantsFullWorkflowInclude("stages"), false);
  });
});
