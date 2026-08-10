"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type TokenRow = {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export function AccountTokensPanel() {
  const [items, setItems] = useState<TokenRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/account/tokens");
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        items?: TokenRow[];
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

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    setCreatedToken(null);
    setCopied(false);
    try {
      const res = await fetch("/api/account/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        token?: string;
      };
      if (!res.ok) {
        setFormError(body.message || `Aanmaken mislukt (${res.status})`);
        return;
      }
      if (body.token) setCreatedToken(body.token);
      setName("");
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(id: string) {
    if (!window.confirm("Deze token intrekken? Agents die hem gebruiken stoppen met werken.")) {
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const res = await fetch(`/api/account/tokens/${encodeURIComponent(id)}/revoke`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setFormError(body.message || `Intrekken mislukt (${res.status})`);
        return;
      }
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copyToken() {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const active = items.filter((t) => !t.revokedAt);
  const revoked = items.filter((t) => t.revokedAt);

  return (
    <div className="account-tokens">
      <form className="create-ticket-form" onSubmit={onCreate}>
        <h3>Nieuwe API-token</h3>
        <p className="muted note">
          Gebruik deze <code>trc_…</code> token in Cursor/Claude MCP (
          <code>TRACEAI_TOKEN</code>). De volledige waarde zie je maar één keer.
        </p>
        <label>
          Naam
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="bijv. Cursor laptop"
            required
            autoComplete="off"
            disabled={busy}
          />
        </label>
        {formError ? <p className="create-ticket-error">{formError}</p> : null}
        <button type="submit" className="btn" disabled={busy || !name.trim()}>
          Token aanmaken
        </button>
      </form>

      {createdToken ? (
        <div className="panel account-token-secret" role="status">
          <h3>Bewaar je token nu</h3>
          <p className="muted note">
            Dit is de enige keer dat de volledige token wordt getoond. Kopieer hem
            naar je MCP-config en bewaar hem veilig.
          </p>
          <pre className="code-block">{createdToken}</pre>
          <button type="button" className="btn btn-small" onClick={() => void copyToken()}>
            {copied ? "Gekopieerd" : "Kopieer token"}
          </button>
        </div>
      ) : null}

      {loadError ? (
        <div className="empty">Kon tokens niet laden: {loadError}</div>
      ) : (
        <>
          <section className="account-token-list" aria-labelledby="active-tokens-heading">
            <h3 id="active-tokens-heading">Actieve tokens</h3>
            {active.length === 0 ? (
              <p className="muted">Nog geen actieve tokens.</p>
            ) : (
              <ul className="account-token-rows">
                {active.map((token) => (
                  <li key={token.id}>
                    <div>
                      <strong>{token.name}</strong>
                      <div className="muted note">
                        <code>{token.tokenPrefix}</code> · aangemaakt{" "}
                        {formatDate(token.createdAt)}
                        {token.lastUsedAt
                          ? ` · laatst gebruikt ${formatDate(token.lastUsedAt)}`
                          : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={busy}
                      onClick={() => void onRevoke(token.id)}
                    >
                      Intrekken
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {revoked.length > 0 ? (
            <section
              className="account-token-list"
              aria-labelledby="revoked-tokens-heading"
            >
              <h3 id="revoked-tokens-heading">Ingetrokken</h3>
              <ul className="account-token-rows muted">
                {revoked.map((token) => (
                  <li key={token.id}>
                    <div>
                      <strong>{token.name}</strong>
                      <div className="note">
                        <code>{token.tokenPrefix}</code> · ingetrokken{" "}
                        {formatDate(token.revokedAt)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
