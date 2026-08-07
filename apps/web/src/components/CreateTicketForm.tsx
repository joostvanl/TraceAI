"use client";

import { FormEvent, useState } from "react";

type Props = {
  projectSlug: string;
};

type Priority = "low" | "medium" | "high";

export function CreateTicketForm({ projectSlug }: Props) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: projectSlug,
          title,
          description,
          priority,
          secret,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        slug?: string;
        ticket_key?: string;
      };
      if (!res.ok) {
        setError(body.message ?? `Create failed (${res.status})`);
        return;
      }
      const label = body.ticket_key
        ? `${body.ticket_key} (${body.slug})`
        : body.slug;
      setSuccess(
        label
          ? `Ticket “${label}” created in Backlog.`
          : "Ticket created in Backlog.",
      );
      setTitle("");
      setDescription("");
      setPriority("medium");
      setSecret("");
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="create-ticket">
      <div className="create-ticket-bar">
        <button
          type="button"
          className="btn"
          onClick={() => {
            setOpen((v) => !v);
            setError(null);
            setSuccess(null);
          }}
        >
          {open ? "Cancel" : "New ticket"}
        </button>
        <p className="muted create-ticket-hint">
          Tickets landen in Backlog; een agent refined ze naar To do.
        </p>
      </div>

      {success ? <p className="create-ticket-success">{success}</p> : null}

      {open ? (
        <form className="create-ticket-form" onSubmit={onSubmit}>
          <label>
            <span>Title</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={160}
              placeholder="Korte titel van de wens"
              disabled={submitting}
            />
          </label>

          <label>
            <span>Wish / description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              rows={5}
              placeholder="Beschrijf wat je wilt — refinement volgt later door een agent."
              disabled={submitting}
            />
          </label>

          <div className="create-ticket-row">
            <label>
              <span>Priority</span>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as Priority)}
                disabled={submitting}
              >
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </label>

            <label>
              <span>Create secret</span>
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                required
                autoComplete="off"
                placeholder="Gedeeld wachtwoord"
                disabled={submitting}
              />
            </label>
          </div>

          {error ? <p className="create-ticket-error">{error}</p> : null}

          <button type="submit" className="btn primary" disabled={submitting}>
            {submitting ? "Creating…" : "Create in Backlog"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
