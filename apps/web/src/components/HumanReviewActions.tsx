"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export type HumanGateInfo = {
  /** Stage the agent moves to after an approved verdict. */
  approveTo: string | null;
  /** Stage the agent moves back to after a rejected verdict. */
  rejectTo: string | null;
};

export type ReviewVerdict = {
  state: "approved" | "rejected";
  by: string | null;
  at: string | null;
};

type Props = {
  ticketSlug: string;
  projectSlug: string;
  stageName: string;
  authenticated: boolean;
  gate: HumanGateInfo;
  verdict: ReviewVerdict | null;
};

function formatMoment(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

export function HumanReviewActions({
  ticketSlug,
  projectSlug,
  stageName,
  authenticated,
  gate,
  verdict,
}: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "approve" | "reject">("idle");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [revising, setRevising] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loginHref = `/login?next=${encodeURIComponent(
    `/projects/${projectSlug}/tickets/${ticketSlug}`,
  )}`;

  async function submit(event: FormEvent, action: "approved" | "rejected") {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/tickets/${encodeURIComponent(ticketSlug)}/review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            verdict: action,
            comment: action === "approved" ? note.trim() : reason.trim(),
          }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        throw new Error(data.message ?? `Request failed (${res.status})`);
      }
      setMode("idle");
      setNote("");
      setReason("");
      setRevising(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (verdict && !revising) {
    const approved = verdict.state === "approved";
    const moment = formatMoment(verdict.at);
    const target = approved ? gate.approveTo : gate.rejectTo;
    return (
      <aside className={`human-review ${approved ? "approved" : "rejected"}`}>
        <div className="human-review-kicker">
          {approved ? "Goedgekeurd" : "Afgekeurd"}
        </div>
        <h3>Beoordeling vastgelegd</h3>
        <p className="muted">
          {verdict.by ? <strong>{verdict.by}</strong> : "Een reviewer"}
          {approved ? " keurde " : " keurde "}
          <strong>{stageName}</strong>
          {approved ? " goed" : " af"}
          {moment ? ` op ${moment}` : null}. De agent verplaatst dit ticket
          {target ? (
            <>
              {" "}
              naar <strong>{target}</strong>
            </>
          ) : null}
          .
        </p>
        {authenticated ? (
          <div className="human-review-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setRevising(true);
                setMode("idle");
              }}
            >
              Oordeel wijzigen
            </button>
          </div>
        ) : null}
      </aside>
    );
  }

  if (!authenticated) {
    return (
      <aside className="human-review">
        <div className="human-review-kicker">Wacht op beoordeling</div>
        <h3>Menselijke beoordeling vereist</h3>
        <p className="muted">
          Stage <strong>{stageName}</strong> wacht op een oordeel.{" "}
          <Link href={loginHref}>Log in</Link> om goed of af te keuren.
        </p>
      </aside>
    );
  }

  return (
    <aside className="human-review">
      <div className="human-review-header">
        <div>
          <div className="human-review-kicker">Wacht op beoordeling</div>
          <h3>Jouw oordeel</h3>
          <p className="muted">
            Beoordeel de uitkomst van <strong>{stageName}</strong>. Je oordeel
            verplaatst het ticket niet zelf — de agent doet de transitie
            {gate.approveTo ? (
              <>
                {" "}
                naar <strong>{gate.approveTo}</strong>
              </>
            ) : null}
            {gate.rejectTo ? (
              <>
                {" "}
                of terug naar <strong>{gate.rejectTo}</strong>
              </>
            ) : null}
            .
          </p>
        </div>
      </div>

      {mode === "idle" ? (
        <div className="human-review-actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => setMode("approve")}
          >
            Goedkeuren
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setMode("reject")}
          >
            Afkeuren
          </button>
        </div>
      ) : null}

      {mode === "approve" ? (
        <form
          onSubmit={(e) => submit(e, "approved")}
          className="human-review-form"
        >
          <div className="human-review-form-title">Goedkeuren</div>
          <label>
            Toelichting (optioneel)
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Acceptatiecriteria gecontroleerd."
            />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <div className="human-review-actions">
            <button type="submit" className="btn primary" disabled={submitting}>
              {submitting ? "Bezig…" : "Bevestig goedkeuring"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setMode("idle")}
              disabled={submitting}
            >
              Annuleren
            </button>
          </div>
        </form>
      ) : null}

      {mode === "reject" ? (
        <form
          onSubmit={(e) => submit(e, "rejected")}
          className="human-review-form reject"
        >
          <div className="human-review-form-title">Afkeuren</div>
          <p className="muted">
            De agent brengt dit ticket terug naar{" "}
            <strong>{gate.rejectTo ?? "een eerdere stage"}</strong>.
          </p>
          <label>
            Reden van afkeuring (verplicht)
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              required
              minLength={10}
              placeholder="Wat faalde en wat moet er gebeuren?"
            />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <div className="human-review-actions">
            <button
              type="submit"
              className="btn"
              disabled={submitting || reason.trim().length < 10}
            >
              {submitting ? "Bezig…" : "Bevestig afkeuring"}
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => setMode("idle")}
              disabled={submitting}
            >
              Annuleren
            </button>
          </div>
        </form>
      ) : null}
    </aside>
  );
}
