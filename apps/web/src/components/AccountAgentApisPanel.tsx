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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cursorKey, setCursorKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/account/agent-apis");
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        items?: ProviderRow[];
      };
      if (!res.ok) {
        setLoadError(body.message || `Laden mislukt (${res.status})`);
        return;
      }
      setItems(body.items ?? []);
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
