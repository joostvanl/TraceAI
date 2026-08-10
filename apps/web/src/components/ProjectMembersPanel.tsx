"use client";

import { useState, type FormEvent } from "react";

type MemberRow = {
  slug: string;
  project: string;
  user: string;
  role: string;
};

type UserOption = {
  slug: string;
  username: string;
  display_name: string;
};

type ProjectRole = "admin" | "editor" | "viewer";

export function ProjectMembersPanel({
  projectSlug,
  members,
  users,
}: {
  projectSlug: string;
  members: MemberRow[];
  users: UserOption[];
}) {
  const [user, setUser] = useState(users[0]?.slug ?? "");
  const [role, setRole] = useState<ProjectRole>("editor");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectSlug)}/members`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user, role }),
        },
      );
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

  async function changeRole(memberUser: string, nextRole: ProjectRole) {
    setRowBusy(memberUser);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectSlug)}/members`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user: memberUser, role: nextRole }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setError(body.message || `Rol wijzigen mislukt (${res.status})`);
        return;
      }
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRowBusy(null);
    }
  }

  async function removeMember(memberUser: string) {
    if (
      !window.confirm(
        `Lid ${memberUser} verwijderen van dit project?`,
      )
    ) {
      return;
    }
    setRowBusy(memberUser);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectSlug)}/members/${encodeURIComponent(memberUser)}`,
        { method: "DELETE" },
      );
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setError(body.message || `Verwijderen mislukt (${res.status})`);
        return;
      }
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRowBusy(null);
    }
  }

  return (
    <div className="panel">
      <h2>Projectleden</h2>
      {members.length === 0 ? (
        <p className="muted">Nog geen leden gekoppeld.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Rol</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.slug}>
                <td>
                  <code>{m.user}</code>
                </td>
                <td>
                  <select
                    value={m.role}
                    disabled={rowBusy === m.user}
                    onChange={(e) =>
                      changeRole(m.user, e.target.value as ProjectRole)
                    }
                  >
                    <option value="admin">admin</option>
                    <option value="editor">editor</option>
                    <option value="viewer">viewer</option>
                  </select>
                </td>
                <td>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={rowBusy === m.user}
                    onClick={() => removeMember(m.user)}
                  >
                    Verwijderen
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form className="create-ticket-form" onSubmit={onSubmit}>
        <h3>Lid toevoegen / bijwerken</h3>
        <label>
          Gebruiker
          <select
            value={user}
            onChange={(e) => setUser(e.target.value)}
            required
          >
            {users.map((u) => (
              <option key={u.slug} value={u.slug}>
                {u.display_name} ({u.username})
              </option>
            ))}
          </select>
        </label>
        <label>
          Rol
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as ProjectRole)}
          >
            <option value="admin">admin</option>
            <option value="editor">editor</option>
            <option value="viewer">viewer</option>
          </select>
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <button type="submit" className="btn" disabled={busy || !user}>
          {busy ? "Bezig…" : "Opslaan"}
        </button>
      </form>
    </div>
  );
}
