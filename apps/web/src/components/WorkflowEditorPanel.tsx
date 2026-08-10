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
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeMouseHandler,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
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

function stageNodes(
  stages: WorkflowStage[],
  layoutNodes: Array<{ id: string; x: number; y: number }>,
): Node[] {
  const positions = new Map(layoutNodes.map((n) => [n.id, n]));
  return stages.map((stage, index) => {
    const pos = positions.get(stage.key) ?? {
      id: stage.key,
      x: 80 + (index % 3) * 240,
      y: 80 + Math.floor(index / 3) * 120,
    };
    return {
      id: stage.key,
      position: { x: pos.x, y: pos.y },
      data: {
        label: stage.name,
        key: stage.key,
        gated: Boolean(stage.agent?.require_human_approval_on_exit),
      },
      style: {
        border: stage.agent?.require_human_approval_on_exit
          ? "2px solid var(--priority-medium)"
          : "1px solid var(--border)",
        background: "var(--bg-elevated)",
        color: "var(--text)",
        borderRadius: 8,
        padding: "10px 14px",
        minWidth: 140,
        fontSize: 13,
      },
    };
  });
}

function stageEdges(stages: WorkflowStage[]): Edge[] {
  const edges: Edge[] = [];
  for (const stage of stages) {
    for (const target of stage.transitions) {
      edges.push({
        id: `${stage.key}->${target}`,
        source: stage.key,
        target,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: "var(--accent)" },
      });
    }
  }
  return edges;
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
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            id: `${connection.source}->${connection.target}`,
            markerEnd: { type: MarkerType.ArrowClosed },
            style: { stroke: "var(--accent)" },
          },
          eds,
        ),
      );
      setStages((prev) =>
        prev.map((stage) =>
          stage.key === connection.source &&
          !stage.transitions.includes(connection.target!)
            ? {
                ...stage,
                transitions: [...stage.transitions, connection.target!],
              }
            : stage,
        ),
      );
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

  function layoutFromNodes() {
    return {
      nodes: nodes.map((node) => ({
        id: node.id,
        x: node.position.x,
        y: node.position.y,
      })),
    };
  }

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
            edges={edges}
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
                  rows={4}
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
          rows={2}
        />
      </label>
      <label>
        on_enter (één per regel)
        <textarea
          value={linesToText(agent.on_enter)}
          onChange={(event) =>
            onChange({ agent: { on_enter: textToLines(event.target.value) } })
          }
          rows={3}
        />
      </label>
      <label>
        on_exit (één per regel)
        <textarea
          value={linesToText(agent.on_exit)}
          onChange={(event) =>
            onChange({ agent: { on_exit: textToLines(event.target.value) } })
          }
          rows={3}
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
                      : undefined,
                  },
                })
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
          rows={4}
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
