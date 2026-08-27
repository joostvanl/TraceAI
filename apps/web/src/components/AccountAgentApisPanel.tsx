"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type ProviderRow = {
  provider: string;
  configured: boolean;
  last4: string | null;
};

const LABELS: Record<string, string> = {
  cursor: "Cursor",
  claude_code: "Claude Code",
  codex: "Codex",
};

export function AccountAgentApisPanel() {
  const [items, setItems] = useState<ProviderRow[]>([]);
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  const [defaultAgentDraft, setDefaultAgentDraft] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cursorKey, setCursorKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [defaultError, setDefaultError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/account/agent-apis");
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        items?: ProviderRow[];
        default_cursor_agent_id?: string | null;
      };
      if (!res.ok) {
        setLoadError(body.message || `Laden mislukt (${res.status})`);
        return;
      }
      setItems(body.items ?? []);
      const current = body.default_cursor_agent_id?.trim() || null;
      setDefaultAgentId(current);
      setDefaultAgentDraft(current ?? "");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const cursor = items.find((row) => row.provider === "cursor");
  const later = items.filter((row) => row.provider !== "cursor");

  async function onSave(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/account/agent-apis", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "cursor",
          api_key: cursorKey,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        last4?: string;
      };
      if (!res.ok) {
        setFormError(body.message || `Opslaan mislukt (${res.status})`);
        return;
      }
      setCursorKey("");
      setNotice(
        body.last4
          ? `Cursor-key opgeslagen (****${body.last4}).`
          : "Cursor-key opgeslagen.",
      );
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onRemove() {
    if (
      !window.confirm(
        "Cursor API-key verwijderen? Cloud-agents worden daarna niet meer automatisch wakker tot je een nieuwe key opslaat.",
      )
    ) {
      return;
    }
    setBusy(true);
    setFormError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/account/agent-apis?provider=cursor", {
        method: "DELETE",
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setFormError(body.message || `Verwijderen mislukt (${res.status})`);
        return;
      }
      setNotice("Cursor-key verwijderd.");
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSaveDefault(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setDefaultError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/account/default-agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: defaultAgentDraft }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        agent_id?: string | null;
      };
      if (!res.ok) {
        setDefaultError(body.message || `Opslaan mislukt (${res.status})`);
        return;
      }
      setNotice(
        body.agent_id
          ? `Default agent opgeslagen (${body.agent_id}).`
          : "Default agent gewist.",
      );
      await refresh();
    } catch (err) {
      setDefaultError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onClearDefault() {
    setBusy(true);
    setDefaultError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/account/default-agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "" }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setDefaultError(body.message || `Wissen mislukt (${res.status})`);
        return;
      }
      setNotice("Default agent gewist.");
      await refresh();
    } catch (err) {
      setDefaultError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="account-tokens">
      {loadError ? (
        <div className="empty">Kon Agent APIs niet laden: {loadError}</div>
      ) : (
        <>
          <form className="create-ticket-form" onSubmit={(e) => void onSave(e)}>
            <h3>Cursor</h3>
            <p className="muted note">
              Plak een Cursor API-key. Na opslaan toont TraceAI alleen de
              laatste vier tekens — nooit de volledige key.
            </p>
            {cursor?.configured && cursor.last4 ? (
              <p className="muted">
                Geconfigureerd: <code>****{cursor.last4}</code>
              </p>
            ) : (
              <p className="muted">Nog geen Cursor-key opgeslagen.</p>
            )}
            <label>
              API-key
              <input
                type="password"
                value={cursorKey}
                onChange={(e) => setCursorKey(e.target.value)}
                placeholder="Cursor API-key"
                autoComplete="off"
                disabled={busy}
              />
            </label>
            {formError ? <p className="create-ticket-error">{formError}</p> : null}
            {notice ? <p className="muted note">{notice}</p> : null}
            <div className="account-agent-api-actions">
              <button
                type="submit"
                className="btn"
                disabled={busy || !cursorKey.trim()}
              >
                {cursor?.configured ? "Vervangen" : "Opslaan"}
              </button>
              {cursor?.configured ? (
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={busy}
                  onClick={() => void onRemove()}
                >
                  Verwijderen
                </button>
              ) : null}
            </div>
          </form>

          <form
            className="create-ticket-form"
            onSubmit={(e) => void onSaveDefault(e)}
          >
            <h3>Default agent</h3>
            <p className="muted note">
              Cursor Cloud-id (<code>bc-…</code>). Wijzigt vaak; dit veld is
              los van de API-key. Nieuwe tickets op Backlog wekken deze agent.
            </p>
            {defaultAgentId ? (
              <p className="muted">
                Huidig: <code>{defaultAgentId}</code>
              </p>
            ) : (
              <p className="muted">Nog geen default agent.</p>
            )}
            <label>
              Default agent
              <input
                type="text"
                value={defaultAgentDraft}
                onChange={(e) => setDefaultAgentDraft(e.target.value)}
                placeholder="bc-…"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
            </label>
            {defaultError ? (
              <p className="create-ticket-error">{defaultError}</p>
            ) : null}
            <div className="account-agent-api-actions">
              <button type="submit" className="btn" disabled={busy}>
                Opslaan
              </button>
              {defaultAgentId ? (
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={busy}
                  onClick={() => void onClearDefault()}
                >
                  Wissen
                </button>
              ) : null}
            </div>
          </form>

          <section
            className="account-token-list"
            aria-labelledby="later-agent-apis-heading"
          >
            <h3 id="later-agent-apis-heading">Later</h3>
            <ul className="account-token-rows">
              {(later.length > 0
                ? later
                : [
                    { provider: "claude_code", configured: false, last4: null },
                    { provider: "codex", configured: false, last4: null },
                  ]
              ).map((row) => (
                <li key={row.provider} className="account-agent-api-later">
                  <div>
                    <strong>{LABELS[row.provider] ?? row.provider}</strong>
                    <div className="muted note">Later — nog niet configureerbaar.</div>
                  </div>
                  <button type="button" className="btn btn-small" disabled>
                    Later
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
