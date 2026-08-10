"use client";

import { useState } from "react";

export function MarkNotificationsReadButton({ count }: { count: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setError(body.message || `Mislukt (${res.status})`);
        return;
      }
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={busy}
        onClick={onClick}
      >
        {busy ? "Bezig…" : `Markeer ${count} notificatie(s) gelezen`}
      </button>
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}
