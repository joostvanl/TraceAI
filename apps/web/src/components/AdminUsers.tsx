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
        </tr>
      </thead>
      <tbody>
        {users.map((u) => (
          <tr key={u.slug}>
            <td>
              <code>{u.username}</code>
            </td>
            <td>{u.display_name}</td>
            <td>{u.status}</td>
            <td>{u.is_platform_admin ? "platform-admin" : "user"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
