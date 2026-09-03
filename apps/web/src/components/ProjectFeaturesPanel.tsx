"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

export function ProjectFeaturesPanel({
  projectSlug,
  legacy,
  canWrite,
}: {
  projectSlug: string;
  legacy: boolean;
  canWrite: boolean;
}) {
  const [enabled, setEnabled] = useState(false);
  const [draft, setDraft] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectSlug)}/live-board-activity`,
      );
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        enabled?: boolean;
      };
      if (!res.ok) {
        setLoadError(body.message || `Laden mislukt (${res.status})`);
        return;
      }
      const current = body.enabled === true;
      setEnabled(current);
      setDraft(current);
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
        `/api/projects/${encodeURIComponent(projectSlug)}/live-board-activity`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: draft }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        enabled?: boolean;
      };
      if (!res.ok) {
        setFormError(body.message || `Opslaan mislukt (${res.status})`);
        return;
      }
      setNotice(
        body.enabled
          ? "Vluchtige board-updates staan aan. Agents krijgen de vaste instructie via get_project en get_workflow."
          : "Vluchtige board-updates staan uit. MCP-antwoorden blijven ongewijzigd.",
      );
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
        Functies instellen vereist een persoonlijk TraceAI-account. Shared login
        kan dit niet zetten.
      </p>
    );
  }

  return (
    <section
      className="create-ticket-form account-cursor-panel"
      aria-labelledby="project-features-heading"
    >
      <h3 id="project-features-heading">Vluchtige board-updates</h3>
      {loadError ? (
        <p className="form-error">{loadError}</p>
      ) : (
        <form onSubmit={(e) => void onSave(e)}>
          <p className="muted note">
            Als dit aan staat, plakt TraceAI een vaste instructie in{" "}
            <code>get_project</code> en <code>get_workflow</code>: agents moeten
            een korte regel op de geclaimde kaart zetten (
            <code>set_ticket_activity</code>). De workflow-editor bewaart die
            tekst niet.
          </p>
          {canWrite ? null : (
            <p className="muted note">
              Alleen lezen: je ziet de stand maar kunt hem niet wijzigen.
            </p>
          )}
          {notice ? <p className="muted note">{notice}</p> : null}
          <p className="muted">
            Huidig: <strong>{enabled ? "aan" : "uit"}</strong>
          </p>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft}
              onChange={(e) => setDraft(e.target.checked)}
              disabled={busy || !canWrite}
            />
            Agents moeten vluchtige updates op het live board zetten
          </label>
          {formError ? <p className="create-ticket-error">{formError}</p> : null}
          {canWrite ? (
            <div className="account-agent-api-actions">
              <button
                type="submit"
                className="btn"
                disabled={busy || draft === enabled}
              >
                Opslaan
              </button>
            </div>
          ) : null}
        </form>
      )}
    </section>
  );
}
