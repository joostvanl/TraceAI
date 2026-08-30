"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type AgentRow = {
  cursor_agent_id: string;
  display_name: string;
};

export function ProjectAgentsPanel({
  projectSlug,
  legacy,
  canWrite,
}: {
  projectSlug: string;
  legacy: boolean;
  canWrite: boolean;
}) {
  const [rows, setRows] = useState<AgentRow[]>([]);
  const [idDraft, setIdDraft] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const [agentsRes, defaultRes] = await Promise.all([
        fetch(`/api/projects/${encodeURIComponent(projectSlug)}/agents`),
        fetch(`/api/projects/${encodeURIComponent(projectSlug)}/default-agent`),
      ]);
      const agentsBody = (await agentsRes.json().catch(() => ({}))) as {
        message?: string;
        items?: AgentRow[];
      };
      if (!agentsRes.ok) {
        setLoadError(agentsBody.message || `Laden mislukt (${agentsRes.status})`);
        return;
      }
      setRows(Array.isArray(agentsBody.items) ? agentsBody.items : []);
      if (defaultRes.ok) {
        const defaultBody = (await defaultRes.json().catch(() => ({}))) as {
          agent_id?: string | null;
        };
        const pref = defaultBody.agent_id?.trim();
        if (pref) {
          setIdDraft((current) => current || pref);
        }
      }
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
        `/api/projects/${encodeURIComponent(projectSlug)}/agents`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cursor_agent_id: idDraft,
            display_name: nameDraft,
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        code?: string;
        cursor_agent_id?: string;
        display_name?: string;
      };
      if (!res.ok) {
        setFormError(body.message || `Opslaan mislukt (${res.status})`);
        return;
      }
      setNotice(
        body.display_name
          ? `Weergavenaam opgeslagen (${body.display_name}).`
          : "Weergavenaam gewist; het id blijft staan.",
      );
      setNameDraft(body.display_name ?? "");
      if (body.cursor_agent_id) setIdDraft(body.cursor_agent_id);
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
        Weergavenamen instellen vereist een persoonlijk TraceAI-account. Shared
        login kan dit niet zetten.
      </p>
    );
  }

  return (
    <section
      className="create-ticket-form account-cursor-panel"
      aria-labelledby="project-agents-heading"
    >
      <h3 id="project-agents-heading">Agents</h3>
      {loadError ? (
        <p className="form-error">{loadError}</p>
      ) : (
        <>
          <p className="muted note">
            Weergavenaam per Cursor Cloud-id (<code>bc-…</code>) voor{" "}
            <strong>dit</strong> project. Board en ticketdetail tonen de naam
            na een refresh. Los van Default agent en van de API-key op Agent
            APIs.
          </p>
          {canWrite ? null : (
            <p className="muted note">
              Alleen lezen: je ziet de lijst maar kunt geen naam opslaan.
            </p>
          )}
          {notice ? <p className="muted note">{notice}</p> : null}
          {rows.length === 0 ? (
            <p className="muted">Nog geen weergavenamen voor dit project.</p>
          ) : (
            <ul className="muted">
              {rows.map((row) => (
                <li key={row.cursor_agent_id}>
                  <code>{row.cursor_agent_id}</code>
                  {row.display_name?.trim()
                    ? ` — ${row.display_name}`
                    : " — (geen naam)"}
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={(e) => void onSave(e)}>
            <label>
              Cursor agent id
              <input
                type="text"
                value={idDraft}
                onChange={(e) => setIdDraft(e.target.value)}
                placeholder="bc-…"
                autoComplete="off"
                spellCheck={false}
                disabled={busy || !canWrite}
                readOnly={!canWrite}
              />
            </label>
            <label>
              Weergavenaam
              <input
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder="Henk"
                autoComplete="off"
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
              </div>
            ) : null}
          </form>
        </>
      )}
    </section>
  );
}
