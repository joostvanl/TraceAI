"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

export function ProjectDefaultAgentPanel({
  projectSlug,
  legacy,
  canWrite,
}: {
  projectSlug: string;
  legacy: boolean;
  canWrite: boolean;
}) {
  const [agentId, setAgentId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectSlug)}/default-agent`,
      );
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        agent_id?: string | null;
      };
      if (!res.ok) {
        setLoadError(body.message || `Laden mislukt (${res.status})`);
        return;
      }
      const current = body.agent_id?.trim() || null;
      setAgentId(current);
      setDraft(current ?? "");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [projectSlug]);

  useEffect(() => {
    if (legacy) return;
    void refresh();
  }, [legacy, refresh]);

  async function onSave(event: FormEvent) {
    event.preventDefault();
    if (!canWrite) return;
    setBusy(true);
    setFormError(null);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectSlug)}/default-agent`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent_id: draft }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        agent_id?: string | null;
      };
      if (!res.ok) {
        setFormError(body.message || `Opslaan mislukt (${res.status})`);
        return;
      }
      setNotice(
        body.agent_id
          ? `Default agent opgeslagen (${body.agent_id}).`
          : "Default agent gewist.",
      );
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onClear() {
    if (!canWrite) return;
    setBusy(true);
    setFormError(null);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectSlug)}/default-agent`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent_id: "" }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setFormError(body.message || `Wissen mislukt (${res.status})`);
        return;
      }
      setNotice("Default agent gewist.");
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (legacy) {
    return (
      <p className="muted">
        Default agent instellen vereist een persoonlijk TraceAI-account. Shared
        login kan dit niet zetten.
      </p>
    );
  }

  return (
    <section
      className="create-ticket-form account-cursor-panel"
      aria-labelledby="project-default-agent-heading"
    >
      <h3 id="project-default-agent-heading">Default agent</h3>
      {loadError ? (
        <p className="form-error">{loadError}</p>
      ) : (
        <form onSubmit={(e) => void onSave(e)}>
          <p className="muted note">
            Project-eigen Cursor Cloud-id (<code>bc-…</code>) voor{" "}
            <strong>dit</strong> project. Nieuwe tickets op de eerste
            workflow-stage wekken deze agent. Los van de API-key op Agent APIs.
          </p>
          {canWrite ? null : (
            <p className="muted note">
              Alleen lezen: je ziet het id maar kunt het niet wijzigen.
            </p>
          )}
          {notice ? <p className="muted note">{notice}</p> : null}
          {agentId ? (
            <p className="muted">
              Huidig: <code>{agentId}</code>
            </p>
          ) : (
            <p className="muted">Nog geen default agent voor dit project.</p>
          )}
          <label>
            Default agent
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="bc-…"
              autoComplete="off"
              spellCheck={false}
              disabled={busy || !canWrite}
              readOnly={!canWrite}
            />
          </label>
          {formError ? <p className="create-ticket-error">{formError}</p> : null}
          {canWrite ? (
            <div className="account-agent-api-actions">
              <button type="submit" className="btn" disabled={busy}>
                Opslaan
              </button>
              {agentId ? (
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={busy}
                  onClick={() => void onClear()}
                >
                  Wissen
                </button>
              ) : null}
            </div>
          ) : null}
        </form>
      )}
    </section>
  );
}
