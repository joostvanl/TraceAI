"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { newestFirstCapped } from "@traceai/core";

export type BoardTicket = {
  slug: string;
  /** Immutable display key, e.g. TRA-42 */
  ticketKey?: string | null;
  title: string;
  stage: string;
  priority: string;
  /** When the ticket last entered its current stage (ISO). Used to sort last stage newest-first. */
  stageChangedAt?: string;
  tokensEstimate?: number | null;
  tokensActual?: number | null;
  /** Closure reason when set (typically on last stage). */
  resolution?: string | null;
};

export type BoardStage = {
  key: string;
  name: string;
};

type TicketEvent = {
  type: string;
  project: string;
  ticket: {
    slug: string;
    ticket_key?: string | null;
    title: string;
    stage: string;
    priority?: string;
    project: string;
    tokens_estimate?: number | null;
    tokens_actual?: number | null;
    resolution?: string | null;
  };
  from_stage?: string;
  to_stage?: string;
  at: string;
};

type Props = {
  projectSlug: string;
  stages: BoardStage[];
  /** Last workflow stage key — column shows only the newest tickets. */
  lastStageKey?: string;
  initialTickets: BoardTicket[];
  eventsUrl: string;
};

function formatTokenCount(value: number): string {
  if (value >= 1000) {
    const k = value / 1000;
    return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  return String(value);
}

function tokenLabel(ticket: BoardTicket): string | null {
  const estimate =
    typeof ticket.tokensEstimate === "number" ? ticket.tokensEstimate : null;
  const actual =
    typeof ticket.tokensActual === "number" ? ticket.tokensActual : null;
  if (estimate == null && actual == null) return null;
  const left = estimate != null ? `~${formatTokenCount(estimate)}` : "—";
  const right = actual != null ? formatTokenCount(actual) : "—";
  return `${left} / ${right}`;
}

function groupByStage(
  stages: BoardStage[],
  tickets: BoardTicket[],
  lastStageKey?: string,
): Record<string, BoardTicket[]> {
  const map: Record<string, BoardTicket[]> = {};
  for (const stage of stages) map[stage.key] = [];
  for (const ticket of tickets) {
    if (!map[ticket.stage]) map[ticket.stage] = [];
    map[ticket.stage].push(ticket);
  }
  if (lastStageKey && map[lastStageKey]) {
    map[lastStageKey] = newestFirstCapped(
      map[lastStageKey],
      (t) => t.stageChangedAt,
    );
  }
  return map;
}

export function LiveBoard({
  projectSlug,
  stages,
  lastStageKey,
  initialTickets,
  eventsUrl,
}: Props) {
  const [tickets, setTickets] = useState<BoardTicket[]>(initialTickets);
  const [flashSlug, setFlashSlug] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<"connecting" | "live" | "offline">(
    "connecting",
  );
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);

  const ticketsByStage = useMemo(
    () => groupByStage(stages, tickets, lastStageKey),
    [stages, tickets, lastStageKey],
  );

  // Surfaced next to the status: writes to a different API instance are
  // published in-process there and never reach this stream.
  const eventsHost = useMemo(() => {
    try {
      return new URL(eventsUrl).host;
    } catch {
      return null;
    }
  }, [eventsUrl]);

  useEffect(() => {
    setTickets(initialTickets);
  }, [initialTickets]);

  useEffect(() => {
    if (!eventsUrl) {
      setLiveState("offline");
      return;
    }

    const url = new URL(eventsUrl);
    url.searchParams.set("project", projectSlug);
    const source = new EventSource(url.toString());
    let flashTimer: ReturnType<typeof setTimeout> | undefined;

    const applyEvent = (raw: MessageEvent) => {
      let event: TicketEvent;
      try {
        event = JSON.parse(String(raw.data)) as TicketEvent;
      } catch {
        return;
      }
      if (event.project && event.project !== projectSlug) return;
      if (!event.ticket?.slug) return;

      setLastEventAt(event.at ?? new Date().toISOString());
      setLiveState("live");

      setTickets((prev) => {
        const without = prev.filter((t) => t.slug !== event.ticket.slug);
        if (event.type === "ticket.commented") {
          // Keep placement; optional highlight only.
          return prev;
        }
        const previous = prev.find((t) => t.slug === event.ticket.slug);
        const next: BoardTicket = {
          slug: event.ticket.slug,
          ticketKey: event.ticket.ticket_key ?? previous?.ticketKey ?? null,
          title: event.ticket.title,
          stage: event.ticket.stage,
          priority: event.ticket.priority ?? "medium",
          stageChangedAt:
            event.type === "ticket.transitioned" || !previous
              ? (event.at ?? new Date().toISOString())
              : previous.stageChangedAt,
          tokensEstimate:
            event.ticket.tokens_estimate ?? previous?.tokensEstimate ?? null,
          tokensActual:
            event.ticket.tokens_actual ?? previous?.tokensActual ?? null,
          resolution: event.ticket.resolution ?? previous?.resolution ?? null,
        };
        return [...without, next];
      });

      setFlashSlug(event.ticket.slug);
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => setFlashSlug(null), 1600);
    };

    source.addEventListener("connected", () => setLiveState("live"));
    source.addEventListener("ticket.created", applyEvent);
    source.addEventListener("ticket.updated", applyEvent);
    source.addEventListener("ticket.transitioned", applyEvent);
    source.addEventListener("ticket.commented", applyEvent);

    source.onopen = () => setLiveState("live");
    source.onerror = () => setLiveState("offline");

    return () => {
      if (flashTimer) clearTimeout(flashTimer);
      source.close();
    };
  }, [eventsUrl, projectSlug]);

  return (
    <div className="live-board">
      <div className="live-status" aria-live="polite">
        <span
          className={`live-dot ${liveState === "live" ? "on" : liveState === "connecting" ? "pending" : "off"}`}
        />
        <span className="muted">
          {liveState === "live"
            ? "Live"
            : liveState === "connecting"
              ? "Connecting…"
              : "Offline — open this page after the TraceAI API is running"}
          {liveState === "live" && eventsHost ? ` · ${eventsHost}` : null}
          {lastEventAt
            ? ` · last update ${new Date(lastEventAt).toLocaleTimeString()}`
            : null}
        </span>
      </div>

      <div className="board">
        {stages.map((stage) => {
          const columnTickets = ticketsByStage[stage.key] ?? [];
          return (
            <section key={stage.key} className="column">
              <div className="column-header">
                <h2>{stage.name}</h2>
                <span className="count">{columnTickets.length}</span>
              </div>
              {columnTickets.length === 0 ? (
                <p
                  className="muted"
                  style={{ fontSize: "0.85rem", margin: "0.25rem" }}
                >
                  Empty
                </p>
              ) : (
                columnTickets.map((ticket) => {
                  const tokens = tokenLabel(ticket);
                  const showResolution =
                    Boolean(ticket.resolution) &&
                    (lastStageKey == null || stage.key === lastStageKey);
                  return (
                  <Link
                    key={ticket.slug}
                    href={`/projects/${projectSlug}/tickets/${ticket.slug}`}
                    className={`ticket-card${flashSlug === ticket.slug ? " ticket-flash" : ""}`}
                  >
                    {ticket.ticketKey ? (
                      <div className="ticket-key">{ticket.ticketKey}</div>
                    ) : null}
                    <h3>{ticket.title}</h3>
                    <div className="meta-row">
                      <span className={`badge ${ticket.priority}`}>
                        {ticket.priority}
                      </span>
                      {showResolution ? (
                        <span className="badge">{ticket.resolution}</span>
                      ) : null}
                      {tokens ? (
                        <span className="muted" style={{ fontSize: "0.75rem" }}>
                          {tokens}
                        </span>
                      ) : null}
                    </div>
                  </Link>
                  );
                })
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
