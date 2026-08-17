"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
  type NodeTypes,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import {
  documentToCanvas,
  getEdgeScopedRules,
  setEdgeScopedRules,
  summarizeWorkflowBehaviour,
  validateWorkflowDocument,
  type TicketTemplate,
  type WorkflowDocument,
  type WorkflowStage,
  type WorkflowStageAgentRules,
} from "@traceai/core";

type WorkflowPayload = {
  slug: string;
  name: string;
  project: string;
  workflow_document: WorkflowDocument;
};

type Selection =
  | { kind: "stage"; key: string }
  | { kind: "edge"; id: string; source: string; target: string }
  | null;

type ActivationPreview = {
  impact: {
    removed_stages: string[];
    added_stages: string[];
    tickets_needing_migration: number;
    tickets_by_removed_stage: Record<
      string,
      Array<{ slug: string; ticket_key: string | null; title: string }>
    >;
  };
  validation_issues: Array<{ code: string; message: string }>;
  behaviour_summary: string;
};

type VersionRow = {
  id: string;
  label: string | null;
  createdAt: string;
};

const NODE_WIDTH = 176;
const NODE_HEIGHT = 56;
// Forward transitions leave on the right and enter on the left; backward
// transitions (reject/reopen) use dedicated bottom handles so they can be
// routed underneath the row without crossing through node boxes.
const SOURCE_HANDLE_ID = "out";
const TARGET_HANDLE_ID = "in";
const BACK_SOURCE_HANDLE_ID = "back-out";
const BACK_TARGET_HANDLE_ID = "back-in";

type StageNodeData = {
  label: string;
  key: string;
  gated: boolean;
};

function StageNode({ data, selected }: NodeProps) {
  const stageData = data as StageNodeData;
  return (
    <div
      className={`workflow-node${stageData.gated ? " workflow-node--gated" : ""}${
        selected ? " workflow-node--selected" : ""
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        id={TARGET_HANDLE_ID}
        className="workflow-node__handle"
      />
      <Handle
        type="target"
        position={Position.Bottom}
        id={BACK_TARGET_HANDLE_ID}
        className="workflow-node__handle workflow-node__handle--back"
        style={{ left: "35%" }}
      />
      <span className="workflow-node__name">{stageData.label}</span>
      <span className="workflow-node__key">{stageData.key}</span>
      {stageData.gated ? (
        <span className="workflow-node__gate">human gate</span>
      ) : null}
      <Handle
        type="source"
        position={Position.Right}
        id={SOURCE_HANDLE_ID}
        className="workflow-node__handle"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id={BACK_SOURCE_HANDLE_ID}
        className="workflow-node__handle workflow-node__handle--back"
        style={{ left: "65%" }}
      />
    </div>
  );
}

const nodeTypes: NodeTypes = { stage: StageNode };

function stageNodes(
  stages: WorkflowStage[],
  layoutNodes: Array<{ id: string; x: number; y: number }>,
): Node[] {
  const positions = new Map(layoutNodes.map((n) => [n.id, n]));
  const fallback = layoutStagesLeftToRight(stages);
  return stages.map((stage) => {
    const pos = positions.get(stage.key) ?? fallback.get(stage.key)!;
    return {
      id: stage.key,
      type: "stage",
      position: { x: pos.x, y: pos.y },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      data: {
        label: stage.name,
        key: stage.key,
        gated: Boolean(stage.agent?.require_human_approval_on_exit),
      } satisfies StageNodeData,
    };
  });
}

function stageEdges(stages: WorkflowStage[]): Edge[] {
  const stageIndex = new Map(stages.map((stage, index) => [stage.key, index]));
  const edges: Edge[] = [];
  let backEdgeCount = 0;
  for (const stage of stages) {
    for (const target of stage.transitions) {
      const isBackEdge =
        (stageIndex.get(target) ?? 0) <= (stageIndex.get(stage.key) ?? 0);
      // Stagger each backward edge on a different offset so parallel
      // reject/reopen arrows do not stack on top of each other.
      const backOffset = isBackEdge ? 24 + backEdgeCount * 26 : undefined;
      if (isBackEdge) backEdgeCount += 1;
      const edge = {
        id: `${stage.key}->${target}`,
        source: stage.key,
        target,
        sourceHandle: isBackEdge ? BACK_SOURCE_HANDLE_ID : SOURCE_HANDLE_ID,
        targetHandle: isBackEdge ? BACK_TARGET_HANDLE_ID : TARGET_HANDLE_ID,
        type: "smoothstep",
        pathOptions: { borderRadius: 10, offset: backOffset },
        markerEnd: { type: MarkerType.ArrowClosed },
        zIndex: isBackEdge ? 1 : 2,
        style: {
          stroke: isBackEdge ? "var(--priority-medium)" : "var(--accent)",
          strokeDasharray: isBackEdge ? "6 4" : undefined,
        },
      } as Edge;
      edges.push(edge);
    }
  }
  return edges;
}

function layoutStagesLeftToRight(
  stages: WorkflowStage[],
): Map<string, { x: number; y: number }> {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: "LR",
    nodesep: 60,
    ranksep: 140,
    marginx: 24,
    marginy: 48,
  });
  for (const stage of stages) {
    graph.setNode(stage.key, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const stage of stages) {
    for (const target of stage.transitions) {
      if (stages.some((s) => s.key === target)) {
        graph.setEdge(stage.key, target);
      }
    }
  }
  dagre.layout(graph);
  const positions = new Map<string, { x: number; y: number }>();
  for (const stage of stages) {
    const node = graph.node(stage.key);
    positions.set(stage.key, {
      x: (node?.x ?? 0) - NODE_WIDTH / 2,
      y: (node?.y ?? 0) - NODE_HEIGHT / 2,
    });
  }
  return positions;
}

function linesToText(value: string[] | undefined): string {
  return (value ?? []).join("\n");
}

function textToLines(value: string): string[] | undefined {
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines : undefined;
}

export function WorkflowEditorPanel({
  projectSlug,
  initial,
}: {
  projectSlug: string;
  initial: WorkflowPayload;
}) {
  return (
    <ReactFlowProvider>
      <WorkflowEditorPanelInner projectSlug={projectSlug} initial={initial} />
    </ReactFlowProvider>
  );
}

function WorkflowEditorPanelInner({
  projectSlug,
  initial,
}: {
  projectSlug: string;
  initial: WorkflowPayload;
}) {
  const initialCanvas = useMemo(
    () => documentToCanvas(initial.workflow_document),
    [initial.workflow_document],
  );
  const [stages, setStages] = useState(initialCanvas.stages);
  const [agentPolicy, setAgentPolicy] = useState(initialCanvas.agent_policy);
  const [templates, setTemplates] = useState(initialCanvas.ticket_templates);
  const [nodes, setNodes, onNodesChange] = useNodesState(
    stageNodes(initialCanvas.stages, initialCanvas.layout.nodes),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(
    stageEdges(initialCanvas.stages),
  );
  const [selection, setSelection] = useState<Selection>(null);
  const [showJson, setShowJson] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Array<{ message: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ActivationPreview | null>(null);
  const [migration, setMigration] = useState<Record<string, string>>({});
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [hasPending, setHasPending] = useState(
    Boolean(initial.workflow_document.pending),
  );

  const syncEdgesFromStages = useCallback(
    (nextStages: WorkflowStage[]) => {
      setStages(nextStages);
      setEdges(stageEdges(nextStages));
    },
    [setEdges],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      // Rebuild edges from the updated stages so the new transition gets the
      // same handle/routing treatment (forward vs. back) as the rest.
      setStages((prev) => {
        const next = prev.map((stage) =>
          stage.key === connection.source &&
          !stage.transitions.includes(connection.target!)
            ? {
                ...stage,
                transitions: [...stage.transitions, connection.target!],
              }
            : stage,
        );
        setEdges(stageEdges(next));
        return next;
      });
    },
    [setEdges],
  );

  const onEdgesDelete = useCallback((deleted: Edge[]) => {
    setStages((prev) =>
      prev.map((stage) => {
        const removed = deleted
          .filter((edge) => edge.source === stage.key)
          .map((edge) => edge.target);
        if (!removed.length) return stage;
        return {
          ...stage,
          transitions: stage.transitions.filter((t) => !removed.includes(t)),
        };
      }),
    );
  }, []);

  const onNodeDoubleClick: NodeMouseHandler = useCallback((_event, node) => {
    setSelection({ kind: "stage", key: node.id });
  }, []);

  const onEdgeDoubleClick = useCallback(
    (_event: ReactMouseEvent, edge: Edge) => {
      setSelection({
        kind: "edge",
        id: edge.id,
        source: edge.source,
        target: edge.target,
      });
    },
    [],
  );

  const selectedStage = selection?.kind === "stage"
    ? stages.find((s) => s.key === selection.key)
    : undefined;

  const selectedEdgeRules =
    selection?.kind === "edge"
      ? getEdgeScopedRules(
          stages.find((s) => s.key === selection.source),
          selection.target,
        )
      : null;

  const localIssues = useMemo(
    () => validateWorkflowDocument({ stages, agent_policy: agentPolicy }),
    [stages, agentPolicy],
  );

  const behaviour = useMemo(
    () => summarizeWorkflowBehaviour({ stages, agent_policy: agentPolicy }),
    [stages, agentPolicy],
  );

  // Selected transitions light up so it stays clear which arrow the property
  // panel edits, even where several arrows run close together.
  const renderedEdges = useMemo(
    () =>
      edges.map((edge) => {
        const active =
          edge.selected ||
          (selection?.kind === "edge" && selection.id === edge.id);
        if (!active) return edge;
        return {
          ...edge,
          zIndex: 10,
          style: {
            ...edge.style,
            stroke: "var(--accent-bright)",
            strokeWidth: 3,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: "var(--accent-bright)",
          },
        };
      }),
    [edges, selection],
  );

  function layoutFromNodes() {
    return {
      nodes: nodes.map((node) => ({
        id: node.id,
        x: node.position.x,
        y: node.position.y,
      })),
    };
  }

  const autoLayout = useCallback(() => {
    const positions = layoutStagesLeftToRight(stages);
    setNodes((nds) =>
      nds.map((node) => {
        const pos = positions.get(node.id);
        return pos ? { ...node, position: { x: pos.x, y: pos.y } } : node;
      }),
    );
  }, [stages, setNodes]);

  function buildCanvasPayload() {
    return {
      stages,
      edges: edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
      })),
      layout: layoutFromNodes(),
      agent_policy: agentPolicy,
      ticket_templates: templates,
    };
  }

  async function saveDraft() {
    setBusy(true);
    setError(null);
    setIssues([]);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectSlug)}/workflow/draft`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ canvas: buildCanvasPayload() }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        issues?: Array<{ message: string }>;
      };
      if (!res.ok) {
        setError(body.message || `Opslaan mislukt (${res.status})`);
        setIssues(body.issues ?? []);
        return;
      }
      setHasPending(true);
      await loadVersions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadPreview() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectSlug)}/workflow/activate`,
      );
      const body = (await res.json().catch(() => ({}))) as ActivationPreview & {
        message?: string;
      };
      if (!res.ok) {
        setError(body.message || `Preview mislukt (${res.status})`);
        return;
      }
      setPreview(body);
      const nextMigration: Record<string, string> = {};
      for (const removed of body.impact.removed_stages) {
        nextMigration[removed] =
          migration[removed] || body.impact.added_stages[0] || stages[0]?.key || "";
      }
      setMigration(nextMigration);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    setBusy(true);
    setError(null);
    setIssues([]);
    try {
      // Persist current canvas as draft first so activate sees latest pending.
      const draftRes = await fetch(
        `/api/projects/${encodeURIComponent(projectSlug)}/workflow/draft`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ canvas: buildCanvasPayload() }),
        },
      );
      const draftBody = (await draftRes.json().catch(() => ({}))) as {
        message?: string;
        issues?: Array<{ message: string }>;
      };
      if (!draftRes.ok) {
        setError(draftBody.message || "Draft opslaan voor activate mislukt");
        setIssues(draftBody.issues ?? []);
        return;
      }
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectSlug)}/workflow/activate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ migration }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        issues?: Array<{ message: string }>;
      };
      if (!res.ok) {
        setError(body.message || `Activeren mislukt (${res.status})`);
        setIssues(body.issues ?? []);
        return;
      }
      setHasPending(false);
      setPreview(null);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadVersions() {
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectSlug)}/workflow/versions`,
      );
      if (!res.ok) return;
      const body = (await res.json()) as VersionRow[];
      setVersions(body);
    } catch {
      // versions are optional Aurora capability
    }
  }

  useEffect(() => {
    void loadVersions();
  }, [projectSlug]);

  function updateSelectedStage(
    patch: Partial<WorkflowStage> & { agent?: WorkflowStageAgentRules },
  ) {
    if (selection?.kind !== "stage") return;
    const key = selection.key;
    const next = stages.map((stage) => {
      if (stage.key !== key) return stage;
      const merged = {
        ...stage,
        ...patch,
        agent: patch.agent ? { ...stage.agent, ...patch.agent } : stage.agent,
      };
      return merged;
    });
    if (patch.key && patch.key !== key) {
      // rename key across transitions + selection
      const renamed = next.map((stage) => ({
        ...stage,
        key: stage.key === key ? patch.key! : stage.key,
        transitions: stage.transitions.map((t) => (t === key ? patch.key! : t)),
      }));
      syncEdgesFromStages(renamed);
      setNodes((nds) =>
        nds.map((node) =>
          node.id === key
            ? {
                ...node,
                id: patch.key!,
                data: {
                  ...node.data,
                  key: patch.key,
                  label: patch.name ?? node.data.label,
                },
              }
            : node,
        ),
      );
      setSelection({ kind: "stage", key: patch.key });
      return;
    }
    syncEdgesFromStages(next);
    if (patch.name) {
      setNodes((nds) =>
        nds.map((node) =>
          node.id === key
            ? { ...node, data: { ...node.data, label: patch.name } }
            : node,
        ),
      );
    }
  }

  function updateEdgeRules(nextRules: {
    require_tokens_estimate: boolean;
    require_playbook_description: boolean;
  }) {
    if (selection?.kind !== "edge") return;
    const next = stages.map((stage) =>
      stage.key === selection.source
        ? setEdgeScopedRules(stage, selection.target, nextRules)
        : stage,
    );
    setStages(next);
  }

  function addStage() {
    const base = `stage_${stages.length + 1}`;
    let key = base;
    let i = 2;
    while (stages.some((s) => s.key === key)) {
      key = `${base}_${i++}`;
    }
    const stage: WorkflowStage = {
      key,
      name: `Stage ${stages.length + 1}`,
      transitions: [],
      agent: { purpose: "" },
    };
    const next = [...stages, stage];
    syncEdgesFromStages(next);
    setNodes((nds) => [
      ...nds,
      ...stageNodes([stage], [{ id: key, x: 120 + nds.length * 40, y: 200 }]),
    ]);
    setSelection({ kind: "stage", key });
  }

  function removeSelectedStage() {
    if (selection?.kind !== "stage") return;
    const key = selection.key;
    const next = stages
      .filter((s) => s.key !== key)
      .map((s) => ({
        ...s,
        transitions: s.transitions.filter((t) => t !== key),
      }));
    syncEdgesFromStages(next);
    setNodes((nds) => nds.filter((n) => n.id !== key));
    setSelection(null);
  }

  function upsertTemplate(template: TicketTemplate) {
    setTemplates((prev) => {
      const idx = prev.findIndex((t) => t.slug === template.slug);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = template;
        return copy;
      }
      return [...prev, template];
    });
  }

  return (
    <section className="workflow-editor">
      <header className="workflow-editor__header">
        <div>
          <h2>Workflow-editor</h2>
          <p className="muted">
            Stages als blokken, transitions als pijlen. Dubbelklik voor
            eigenschappen. Draft bewaart via Aurora (pending + version
            checkpoint); activate maakt live.
            {hasPending ? " · Draft aanwezig" : ""}
          </p>
        </div>
        <div className="workflow-editor__actions">
          <button type="button" className="btn btn-secondary" onClick={addStage}>
            Stage toevoegen
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={autoLayout}
          >
            Auto-layout
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShowJson((v) => !v)}
          >
            {showJson ? "Verberg JSON" : "Toon JSON"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void loadPreview()}
          >
            Preview activate
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void saveDraft()}
          >
            Opslaan draft
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || localIssues.length > 0}
            onClick={() => void activate()}
          >
            Activeren
          </button>
        </div>
      </header>

      {error ? <p className="form-error">{error}</p> : null}
      {issues.length || localIssues.length ? (
        <ul className="workflow-editor__issues">
          {[...issues, ...localIssues].map((issue, index) => (
            <li key={`${issue.message}-${index}`}>{issue.message}</li>
          ))}
        </ul>
      ) : null}

      <div className="workflow-editor__body">
        <div className="workflow-editor__canvas">
          <ReactFlow
            nodes={nodes}
            edges={renderedEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onEdgesDelete={onEdgesDelete}
            onNodeDoubleClick={onNodeDoubleClick}
            onEdgeDoubleClick={onEdgeDoubleClick}
            fitView
            deleteKeyCode={["Backspace", "Delete"]}
          >
            <Background gap={18} color="#2a3440" />
            <MiniMap
              nodeColor={() => "#3d9a7a"}
              maskColor="rgba(15,20,25,0.7)"
            />
            <Controls />
          </ReactFlow>
        </div>

        <aside className="workflow-editor__panel">
          {!selection ? (
            <div className="workflow-editor__panel-empty">
              <p className="muted">
                Selecteer een stage of pijl (dubbelklik) om eigenschappen te
                bewerken.
              </p>
              <label>
                Policy summary
                <textarea
                  value={agentPolicy.summary}
                  onChange={(event) =>
                    setAgentPolicy((policy) => ({
                      ...policy,
                      summary: event.target.value,
                    }))
                  }
                  rows={5}
                />
              </label>
              <h3>Gedrag</h3>
              <pre className="workflow-editor__preview">{behaviour}</pre>
              <h3>Tickettemplates</h3>
              <TemplateEditor
                templates={templates}
                onChange={setTemplates}
                onUpsert={upsertTemplate}
              />
              <h3>Aurora-versies</h3>
              {versions.length === 0 ? (
                <p className="muted">Nog geen checkpoints.</p>
              ) : (
                <ul className="workflow-editor__versions">
                  {versions.slice(0, 8).map((version) => (
                    <li key={version.id}>
                      <span>{version.label || version.id}</span>
                      <span className="muted">
                        {new Date(version.createdAt).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          {selection?.kind === "stage" && selectedStage ? (
            <StageProperties
              stage={selectedStage}
              allKeys={stages.map((s) => s.key)}
              onChange={updateSelectedStage}
              onDelete={removeSelectedStage}
            />
          ) : null}

          {selection?.kind === "edge" && selectedEdgeRules ? (
            <EdgeProperties
              source={selection.source}
              target={selection.target}
              rules={selectedEdgeRules}
              onChange={updateEdgeRules}
              onClose={() => setSelection(null)}
            />
          ) : null}
        </aside>
      </div>

      {preview ? (
        <div className="workflow-editor__activate">
          <h3>Activate preview</h3>
          <pre className="workflow-editor__preview">{preview.behaviour_summary}</pre>
          {preview.impact.removed_stages.length ? (
            <div>
              <p>
                Verwijderde stages met tickets: kies migratiedoel vóór activate.
              </p>
              {preview.impact.removed_stages.map((removed) => (
                <label key={removed} className="workflow-editor__migration-row">
                  {removed} (
                  {preview.impact.tickets_by_removed_stage[removed]?.length ?? 0}{" "}
                  tickets) →
                  <select
                    value={migration[removed] ?? ""}
                    onChange={(event) =>
                      setMigration((prev) => ({
                        ...prev,
                        [removed]: event.target.value,
                      }))
                    }
                  >
                    <option value="">Kies stage…</option>
                    {stages.map((stage) => (
                      <option key={stage.key} value={stage.key}>
                        {stage.name} ({stage.key})
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          ) : (
            <p className="muted">Geen ticketmigratie nodig.</p>
          )}
        </div>
      ) : null}

      {showJson ? (
        <pre className="workflow-editor__json">
          {JSON.stringify(
            {
              agent_policy: agentPolicy,
              stages,
              editor_layout: layoutFromNodes(),
              ticket_templates: templates,
            },
            null,
            2,
          )}
        </pre>
      ) : null}
    </section>
  );
}

function StageProperties({
  stage,
  allKeys,
  onChange,
  onDelete,
}: {
  stage: WorkflowStage;
  allKeys: string[];
  onChange: (
    patch: Partial<WorkflowStage> & { agent?: WorkflowStageAgentRules },
  ) => void;
  onDelete: () => void;
}) {
  const agent = stage.agent ?? {};
  return (
    <div className="workflow-editor__props">
      <h3>Stage</h3>
      <label>
        Key
        <input
          value={stage.key}
          onChange={(event) => onChange({ key: event.target.value.trim() })}
        />
      </label>
      <label>
        Naam
        <input
          value={stage.name}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </label>
      <label>
        Purpose
        <textarea
          value={agent.purpose ?? ""}
          onChange={(event) =>
            onChange({ agent: { purpose: event.target.value } })
          }
          rows={4}
        />
      </label>
      <label>
        on_enter (één per regel)
        <textarea
          value={linesToText(agent.on_enter)}
          onChange={(event) =>
            onChange({ agent: { on_enter: textToLines(event.target.value) } })
          }
          rows={6}
        />
      </label>
      <label>
        on_exit (één per regel)
        <textarea
          value={linesToText(agent.on_exit)}
          onChange={(event) =>
            onChange({ agent: { on_exit: textToLines(event.target.value) } })
          }
          rows={6}
        />
      </label>
      <label className="workflow-editor__check">
        <input
          type="checkbox"
          checked={Boolean(agent.require_human_approval_on_exit)}
          onChange={(event) =>
            onChange({
              agent: { require_human_approval_on_exit: event.target.checked },
            })
          }
        />
        Human gate
      </label>
      {agent.require_human_approval_on_exit ? (
        <>
          <label>
            Approve →
            <select
              value={agent.human_approve_to ?? ""}
              onChange={(event) =>
                onChange({ agent: { human_approve_to: event.target.value } })
              }
            >
              <option value="">(auto)</option>
              {stage.transitions.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reject →
            <select
              value={agent.human_reject_to?.[0] ?? ""}
              onChange={(event) =>
                onChange({
                  agent: {
                    human_reject_to: event.target.value
                      ? [event.target.value]
                      : [],
                  },
                })
              }
            >
              <option value="">(geen)</option>
              {stage.transitions.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </label>
          <label>
            Dismiss →
            <select
              value={agent.human_dismiss_to ?? ""}
              onChange={(event) =>
                onChange({
                  agent: {
                    human_dismiss_to: event.target.value || undefined,
                  },
                })
              }
            >
              <option value="">(geen)</option>
              {stage.transitions.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : null}
      <label className="workflow-editor__check">
        <input
          type="checkbox"
          checked={Boolean(agent.require_comment_on_enter)}
          onChange={(event) =>
            onChange({
              agent: { require_comment_on_enter: event.target.checked },
            })
          }
        />
        Comment bij enter
      </label>
      <label className="workflow-editor__check">
        <input
          type="checkbox"
          checked={Boolean(agent.require_comment_on_exit)}
          onChange={(event) =>
            onChange({
              agent: { require_comment_on_exit: event.target.checked },
            })
          }
        />
        Comment bij exit
      </label>
      <label className="workflow-editor__check">
        <input
          type="checkbox"
          checked={Boolean(agent.require_resolution_on_enter)}
          onChange={(event) =>
            onChange({
              agent: { require_resolution_on_enter: event.target.checked },
            })
          }
        />
        Resolution bij enter
      </label>
      <label>
        Comment template
        <textarea
          value={agent.comment_template ?? ""}
          onChange={(event) =>
            onChange({ agent: { comment_template: event.target.value } })
          }
          rows={6}
        />
      </label>
      <p className="muted">
        Transitions: {stage.transitions.join(", ") || "(geen)"} · bekende keys:{" "}
        {allKeys.join(", ")}
      </p>
      <button type="button" className="btn btn-secondary" onClick={onDelete}>
        Stage verwijderen
      </button>
    </div>
  );
}

function EdgeProperties({
  source,
  target,
  rules,
  onChange,
  onClose,
}: {
  source: string;
  target: string;
  rules: {
    require_tokens_estimate: boolean;
    require_playbook_description: boolean;
  };
  onChange: (rules: {
    require_tokens_estimate: boolean;
    require_playbook_description: boolean;
  }) => void;
  onClose: () => void;
}) {
  return (
    <div className="workflow-editor__props">
      <h3>Transition</h3>
      <p>
        <code>
          {source} → {target}
        </code>
      </p>
      <p className="muted">
        Edges blijven `string[]` op de source-stage; target-scoped regels worden
        hier bewerkt en opgeslagen op de stage-agent config.
      </p>
      <label className="workflow-editor__check">
        <input
          type="checkbox"
          checked={rules.require_tokens_estimate}
          onChange={(event) =>
            onChange({
              ...rules,
              require_tokens_estimate: event.target.checked,
            })
          }
        />
        tokens_estimate verplicht op deze pijl
      </label>
      <label className="workflow-editor__check">
        <input
          type="checkbox"
          checked={rules.require_playbook_description}
          onChange={(event) =>
            onChange({
              ...rules,
              require_playbook_description: event.target.checked,
            })
          }
        />
        Playbook-description verplicht op deze pijl
      </label>
      <button type="button" className="btn btn-secondary" onClick={onClose}>
        Sluiten
      </button>
    </div>
  );
}

function TemplateEditor({
  templates,
  onChange,
  onUpsert,
}: {
  templates: TicketTemplate[];
  onChange: (templates: TicketTemplate[]) => void;
  onUpsert: (template: TicketTemplate) => void;
}) {
  const [slug, setSlug] = useState("playbook");
  const [name, setName] = useState("Playbook");
  const [seed, setSeed] = useState(
    "## Context\n\n## Goal\n\n## What to implement\n\n## Acceptance criteria\n",
  );

  return (
    <div className="workflow-editor__templates">
      {templates.length ? (
        <ul>
          {templates.map((template) => (
            <li key={template.slug}>
              <strong>{template.name}</strong>{" "}
              <span className="muted">({template.slug})</span>
              <button
                type="button"
                className="btn btn-small btn-secondary"
                onClick={() =>
                  onChange(templates.filter((t) => t.slug !== template.slug))
                }
              >
                Verwijder
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nog geen templates.</p>
      )}
      <label>
        Slug
        <input value={slug} onChange={(event) => setSlug(event.target.value)} />
      </label>
      <label>
        Naam
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        Seed body
        <textarea
          value={seed}
          onChange={(event) => setSeed(event.target.value)}
          rows={5}
        />
      </label>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() =>
          onUpsert({
            slug: slug.trim(),
            name: name.trim(),
            seed_body: seed,
            description_headings: [
              "## Context",
              "## Goal",
              "## What to implement",
              "## Acceptance criteria",
            ],
            default_priority: "medium",
          })
        }
      >
        Template opslaan in draft
      </button>
    </div>
  );
}
