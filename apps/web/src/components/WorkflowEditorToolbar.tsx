"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export type EditorWorkflowOption = {
  slug: string;
  name: string;
};

export type CloneSourceOption = {
  slug: string;
  name: string;
  project: string;
};

export function WorkflowEditorToolbar({
  projectSlug,
  workflows,
  selectedSlug,
  defaultSlug,
  canWriteWorkflow,
  isPlatformAdmin,
  cloneSources,
}: {
  projectSlug: string;
  workflows: EditorWorkflowOption[];
  selectedSlug: string;
  defaultSlug: string | null;
  canWriteWorkflow: boolean;
  isPlatformAdmin: boolean;
  cloneSources: CloneSourceOption[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [cloneSource, setCloneSource] = useState(cloneSources[0]?.slug ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isDefault = defaultSlug === selectedSlug;

  function editorHref(workflowSlug: string) {
    const params = new URLSearchParams({ tab: "workflow" });
    if (!defaultSlug || workflowSlug !== defaultSlug) {
      params.set("workflow", workflowSlug);
    }
    return `/projects/${projectSlug}/settings?${params.toString()}`;
  }

  async function createWorkflow(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectSlug)}/workflows`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim() }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        slug?: string;
        message?: string;
      };
      if (!res.ok || !body.slug) {
        setError(body.message || `Aanmaken mislukt (${res.status})`);
        return;
      }
      setName("");
      router.push(editorHref(body.slug));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function setDefault() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectSlug)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ default_workflow: selectedSlug }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setError(body.message || `Default zetten mislukt (${res.status})`);
        return;
      }
      router.push(`/projects/${projectSlug}/settings?tab=workflow`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function cloneWorkflow(event: FormEvent) {
    event.preventDefault();
    if (!cloneSource) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectSlug)}/workflows/clone`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: cloneSource }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        slug?: string;
        message?: string;
      };
      if (!res.ok || !body.slug) {
        setError(body.message || `Clonen mislukt (${res.status})`);
        return;
      }
      router.push(editorHref(body.slug));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workflow-editor-toolbar">
      <nav className="workflow-switcher" aria-label="Projectworkflows">
        {workflows.map((workflow) => {
          const href =
            defaultSlug === workflow.slug
              ? `/projects/${projectSlug}/settings?tab=workflow`
              : `/projects/${projectSlug}/settings?tab=workflow&workflow=${encodeURIComponent(workflow.slug)}`;
          const active = workflow.slug === selectedSlug;
          return (
            <a
              key={workflow.slug}
              href={href}
              className={`workflow-switcher-item${active ? " workflow-switcher-item--active" : ""}`}
            >
              {workflow.name}
              {defaultSlug === workflow.slug ? " (default)" : ""}
            </a>
          );
        })}
      </nav>

      {canWriteWorkflow ? (
        <div className="workflow-editor-toolbar__actions">
          <form onSubmit={createWorkflow} className="workflow-editor-toolbar__form">
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Naam nieuwe workflow"
              aria-label="Naam nieuwe workflow"
              disabled={busy}
            />
            <button
              type="submit"
              className="btn btn-small"
              disabled={busy || !name.trim()}
            >
              Nieuwe workflow
            </button>
          </form>
          <button
            type="button"
            className="btn btn-small btn-secondary"
            onClick={() => void setDefault()}
            disabled={busy || isDefault}
          >
            Als default instellen
          </button>
          {isPlatformAdmin && cloneSources.length > 0 ? (
            <form onSubmit={cloneWorkflow} className="workflow-editor-toolbar__form">
              <select
                value={cloneSource}
                onChange={(event) => setCloneSource(event.target.value)}
                aria-label="Workflow clonen van ander project"
                disabled={busy}
              >
                {cloneSources.map((source) => (
                  <option key={source.slug} value={source.slug}>
                    {source.project}: {source.name}
                  </option>
                ))}
              </select>
              <button type="submit" className="btn btn-small" disabled={busy}>
                Clonen van ander project
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}
