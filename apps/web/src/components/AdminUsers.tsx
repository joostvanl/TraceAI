"use client";

import { useState, type FormEvent } from "react";

type UserRow = {
  slug: string;
  username: string;
  display_name: string;
  email: string | null;
  status: string;
  is_platform_admin: boolean;
  password_set: boolean;
};

export function CreateUserForm({ onCreated }: { onCreated?: () => void }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [platformAdmin, setPlatformAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          display_name: displayName || username,
          email: email || undefined,
          password,
          is_platform_admin: platformAdmin,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      if (!res.ok) {
        setError(body.message || `Create failed (${res.status})`);
        return;
      }
      setUsername("");
      setDisplayName("");
      setEmail("");
      setPassword("");
      setPlatformAdmin(false);
      onCreated?.();
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="create-ticket-form" onSubmit={onSubmit}>
      <h3>Nieuwe gebruiker</h3>
      <label>
        Username
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          autoComplete="off"
        />
      </label>
      <label>
        Weergavenaam
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          autoComplete="off"
        />
      </label>
      <label>
        E-mail
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="off"
        />
      </label>
      <label>
        Wachtwoord
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="new-password"
        />
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={platformAdmin}
          onChange={(e) => setPlatformAdmin(e.target.checked)}
        />
        Platform-admin
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      <button type="submit" className="btn" disabled={busy}>
        {busy ? "Bezig…" : "Gebruiker aanmaken"}
      </button>
    </form>
  );
}

function EditUserRow({ user }: { user: UserRow }) {
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(user.display_name);
  const [email, setEmail] = useState(user.email ?? "");
  const [status, setStatus] = useState(user.status);
  const [platformAdmin, setPlatformAdmin] = useState(user.is_platform_admin);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(user.slug)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: displayName || user.username,
          email: email || null,
          status,
          is_platform_admin: platformAdmin,
          ...(password ? { password } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setError(body.message || `Opslaan mislukt (${res.status})`);
        return;
      }
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <tr>
        <td>
          <code>{user.username}</code>
        </td>
        <td>{user.display_name}</td>
        <td>{user.status}</td>
        <td>{user.is_platform_admin ? "platform-admin" : "user"}</td>
        <td>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setEditing(true)}
          >
            Bewerken
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td colSpan={5}>
        <form className="create-ticket-form" onSubmit={save}>
          <h3>
            Bewerk <code>{user.username}</code>
          </h3>
          <label>
            Weergavenaam
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            E-mail
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="active">active</option>
              <option value="disabled">disabled</option>
            </select>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={platformAdmin}
              onChange={(e) => setPlatformAdmin(e.target.checked)}
            />
            Platform-admin
          </label>
          <label>
            Nieuw wachtwoord (optioneel)
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          {error ? <p className="form-error">{error}</p> : null}
          <div className="btn-row">
            <button type="submit" className="btn" disabled={busy}>
              {busy ? "Bezig…" : "Opslaan"}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setError(null);
                setDisplayName(user.display_name);
                setEmail(user.email ?? "");
                setStatus(user.status);
                setPlatformAdmin(user.is_platform_admin);
                setPassword("");
              }}
            >
              Annuleren
            </button>
          </div>
        </form>
      </td>
    </tr>
  );
}

export function UsersTable({ users }: { users: UserRow[] }) {
  if (users.length === 0) {
    return <p className="muted">Nog geen TraceAI-gebruikers.</p>;
  }
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Username</th>
          <th>Naam</th>
          <th>Status</th>
          <th>Rol</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {users.map((u) => (
          <EditUserRow key={u.slug} user={u} />
        ))}
      </tbody>
    </table>
  );
}
