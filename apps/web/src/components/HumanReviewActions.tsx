"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export type HumanGateInfo = {
  approveTo: string | null;
  rejectTo: string[];
  requireResolution: boolean;
  requireWiki: boolean;
};

type Props = {
  ticketSlug: string;
  projectSlug: string;
  stageName: string;
  authenticated: boolean;
  gate: HumanGateInfo;
};

const RESOLUTIONS = [
  "completed",
  "superseded",
  "cancelled",
  "duplicate",
  "verification-only",
] as const;

export function HumanReviewActions({
  ticketSlug,
  projectSlug,
  stageName,
  authenticated,
  gate,
}: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "approve" | "reject">("idle");
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");
  const [resolution, setResolution] = useState<string>("completed");
  const [wiki, setWiki] = useState("N/A — no lasting documentation change.");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loginHref = `/login?next=${encodeURIComponent(
    `/projects/${projectSlug}/tickets/${ticketSlug}`,
  )}`;

  if (!authenticated) {
    return (
      <div className="human-review panel" style={{ marginTop: "1.25rem" }}>
        <h2>Human approval required</h2>
        <p className="muted">
          Stage <strong>{stageName}</strong> requires a human decision.{" "}
          <Link href={loginHref}>Sign in</Link> to approve or reject.
        </p>
      </div>
    );
  }

  async function submit(event: FormEvent, action: "approve" | "reject") {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const toStage =
        action === "approve" ? gate.approveTo : gate.rejectTo[0] ?? null;
      if (!toStage) {
        throw new Error("No transition target configured for this action.");
      }

      let bodyComment = "";
      if (action === "approve") {
        const parts = [
          "## Vorige stap",
          `Human review of stage "${stageName}".`,
          "",
          "## Deze stap",
          comment.trim() || "Approved via TraceAI UI.",
        ];
        if (gate.requireWiki) {
          parts.push("", "## Wiki", wiki.trim() || "N/A");
        }
        bodyComment = parts.join("\n");
      } else {
        bodyComment = [
          "## Vorige stap",
          `Human review of stage "${stageName}".`,
          "",
          "## Deze stap",
          "Rejected — returning for more work.",
          "",
          "## Reden",
          reason.trim(),
        ].join("\n");
      }

      const payload: Record<string, unknown> = {
        to_stage: toStage,
        comment: bodyComment,
        tokens_used: 0,
      };
      if (action === "approve" && gate.requireResolution) {
        payload.resolution = resolution;
      }

      const res = await fetch(
        `/api/tickets/${encodeURIComponent(ticketSlug)}/transition`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      if (!res.ok) {
        throw new Error(data.message ?? `Request failed (${res.status})`);
      }
      setMode("idle");
      setComment("");
      setReason("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="human-review panel" style={{ marginTop: "1.25rem" }}>
      <h2>Human approval</h2>
      <p className="muted">
        Stage <strong>{stageName}</strong> requires Goedkeuren or Afkeuren.
      </p>

      {mode === "idle" ? (
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          {gate.approveTo ? (
            <button
              type="button"
              className="btn primary"
              onClick={() => setMode("approve")}
            >
              Goedkeuren → {gate.approveTo}
            </button>
          ) : null}
          {gate.rejectTo[0] ? (
            <button
              type="button"
              className="btn"
              onClick={() => setMode("reject")}
            >
              Afkeuren → {gate.rejectTo[0]}
            </button>
          ) : null}
        </div>
      ) : null}

      {mode === "approve" ? (
        <form onSubmit={(e) => submit(e, "approve")} className="stack">
          <label>
            Comment (optional extra note)
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              placeholder="Approved — acceptance criteria verified."
            />
          </label>
          {gate.requireResolution ? (
            <label>
              Resolution
              <select
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                required
              >
                {RESOLUTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {gate.requireWiki ? (
            <label>
              Wiki (slug(s) or N/A + reason)
              <textarea
                value={wiki}
                onChange={(e) => setWiki(e.target.value)}
                rows={2}
                required
              />
            </label>
          ) : null}
          {error ? <p className="error">{error}</p> : null}
          <div style={{ display: "flex", gap: "0.75rem" }}>
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
        <form onSubmit={(e) => submit(e, "reject")} className="stack">
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
          <div style={{ display: "flex", gap: "0.75rem" }}>
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
    </div>
  );
}
