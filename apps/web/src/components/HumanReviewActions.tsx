"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { TicketReviewState } from "@traceai/core";

export type HumanGateInfo = {
  /** Stage key the agent moves to after an approved verdict. */
  approveTo: string | null;
  /** Stage key the agent moves to after a rejected verdict. */
  rejectTo: string | null;
  /** Stage key the agent moves to after a dismissed verdict (optional). */
  dismissTo: string | null;
};

export type ReviewVerdict = {
  state: TicketReviewState;
  by: string | null;
  at: string | null;
};

type VerdictAction = ReviewVerdict["state"];

type Props = {
  ticketSlug: string;
  projectSlug: string;
  stageName: string;
  authenticated: boolean;
  gate: HumanGateInfo;
  verdict: ReviewVerdict | null;
  /** Descendants currently in a human-gated stage (eligible for cascade). */
  gatedChildCount?: number;
};

function formatMoment(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

function verdictLabel(state: VerdictAction): string {
  if (state === "approved") return "Goedgekeurd";
  if (state === "dismissed") return "Geannuleerd";
  return "Afgekeurd";
}

function targetForVerdict(
  gate: HumanGateInfo,
  state: VerdictAction,
): string | null {
  if (state === "approved") return gate.approveTo;
  if (state === "dismissed") return gate.dismissTo;
  return gate.rejectTo;
}

function commentRequiredForVerdict(action: VerdictAction): boolean {
  return action !== "approved";
}

export function HumanReviewActions({
  ticketSlug,
  projectSlug,
  stageName,
  authenticated,
  gate,
  verdict,
  gatedChildCount = 0,
}: Props) {
  const router = useRouter();
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [revising, setRevising] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingVerdict, setPendingVerdict] = useState<VerdictAction | null>(
    null,
  );

  const loginHref = `/login?next=${encodeURIComponent(
    `/projects/${projectSlug}/tickets/${ticketSlug}`,
  )}`;
  const canCascade = gatedChildCount > 0;
  const showApprove = Boolean(gate.approveTo);
  const showReject = Boolean(gate.rejectTo);
  const showDismiss = Boolean(gate.dismissTo);

  async function postVerdict(action: VerdictAction, applyToChildren: boolean) {
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
            comment: comment.trim(),
            apply_to_children: applyToChildren,
          }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        throw new Error(data.message ?? `Request failed (${res.status})`);
      }
      setComment("");
      setRevising(false);
      setPendingVerdict(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function chooseVerdict(action: VerdictAction) {
    if (submitting) return;
    if (commentRequiredForVerdict(action) && !comment.trim()) {
      setError("Dit oordeel heeft een toelichting nodig.");
      return;
    }
    if (canCascade) {
      setError(null);
      setPendingVerdict(action);
      return;
    }
    void postVerdict(action, false);
  }

  if (verdict && !revising) {
    const target = targetForVerdict(gate, verdict.state);
    const tone =
      verdict.state === "approved"
        ? "approved"
        : verdict.state === "dismissed"
          ? "dismissed"
          : "rejected";
    return (
      <aside className={`human-review ${tone}`}>
        <div className="human-review-kicker">{verdictLabel(verdict.state)}</div>
        <h3>Beoordeling vastgelegd</h3>
        <p className="muted">
          {verdict.by ? <strong>{verdict.by}</strong> : "Een reviewer"} legde
          een oordeel vast op <strong>{stageName}</strong>
          {formatMoment(verdict.at) ? ` op ${formatMoment(verdict.at)}` : null}.
          De agent verplaatst dit ticket
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
                setPendingVerdict(null);
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
          <Link href={loginHref}>Log in</Link> om te beoordelen.
        </p>
      </aside>
    );
  }

  if (pendingVerdict) {
    const label = verdictLabel(pendingVerdict);
    return (
      <aside className="human-review cascade-confirm">
        <div className="human-review-kicker">Subtickets</div>
        <h3>Ook children beoordelen?</h3>
        <p className="muted">
          Dit ticket heeft{" "}
          <strong>
            {gatedChildCount} subticket
            {gatedChildCount === 1 ? "" : "s"}
          </strong>{" "}
          die ook op een menselijke beoordeling wachten. Wil je hetzelfde
          oordeel (<strong>{label}</strong>) ook daar vastleggen? De stage
          verandert niet — de agent doet de transitie nog steeds per ticket.
        </p>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="human-review-actions">
          <button
            type="button"
            className="btn primary"
            disabled={submitting}
            onClick={() => void postVerdict(pendingVerdict, true)}
          >
            {submitting ? "Bezig…" : "Ja, ook alle children"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={submitting}
            onClick={() => void postVerdict(pendingVerdict, false)}
          >
            Alleen dit ticket
          </button>
          <button
            type="button"
            className="btn"
            disabled={submitting}
            onClick={() => setPendingVerdict(null)}
          >
            Terug
          </button>
        </div>
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
            Beoordeel <strong>{stageName}</strong>. Je oordeel verplaatst het
            ticket niet zelf — de agent doet de transitie.
          </p>
        </div>
      </div>

      <form
        className="human-review-form"
        onSubmit={(event) => event.preventDefault()}
      >
        <label>
          Toelichting (optioneel bij Goedkeuren; verplicht bij Afkeuren
          {showDismiss ? "/Annuleren" : ""})
          <textarea
            value={comment}
            onChange={(e) => {
              setComment(e.target.value);
              if (error) setError(null);
            }}
            rows={4}
            placeholder="Korte toelichting bij je oordeel."
          />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="human-review-actions">
          {showApprove ? (
            <button
              type="button"
              className="btn primary"
              disabled={submitting}
              onClick={() => chooseVerdict("approved")}
            >
              {submitting ? "Bezig…" : "Goedkeuren"}
            </button>
          ) : null}
          {showReject ? (
            <button
              type="button"
              className="btn"
              disabled={submitting}
              onClick={() => chooseVerdict("rejected")}
            >
              {submitting ? "Bezig…" : "Afkeuren"}
            </button>
          ) : null}
          {showDismiss ? (
            <button
              type="button"
              className="btn"
              disabled={submitting}
              onClick={() => chooseVerdict("dismissed")}
            >
              {submitting ? "Bezig…" : "Annuleren"}
            </button>
          ) : null}
        </div>
      </form>
    </aside>
  );
}
