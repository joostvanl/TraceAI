"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

export type BoardTicket = {
  slug: string;
  title: string;
  stage: string;
  priority: string;
  /** When the ticket last entered its current stage (ISO). Used to sort Done newest-first. */
  stageChangedAt?: string;
};

export type BoardStage = {
  key: string;
  name: string;
};

/** Stages whose column is ordered by most recent stage entry (newest on top). */
const NEWEST_FIRST_STAGES = new Set(["done"]);

type TicketEvent = {
  type: string;
  project: string;
  ticket: {
    slug: string;
    title: string;
    stage: string;
    priority?: string;
    project: string;
  };
  from_stage?: string;
  to_stage?: string;
  at: string;
};

type Props = {
  projectSlug: string;
  stages: BoardStage[];
  initialTickets: BoardTicket[];
  eventsUrl: string;
};

function groupByStage(
  stages: BoardStage[],
  tickets: BoardTicket[],
): Record<string, BoardTicket[]> {
  const map: Record<string, BoardTicket[]> = {};
  for (const stage of stages) map[stage.key] = [];
  for (const ticket of tickets) {
    if (!map[ticket.stage]) map[ticket.stage] = [];
    map[ticket.stage].push(ticket);
  }
  for (const key of Object.keys(map)) {
    if (NEWEST_FIRST_STAGES.has(key)) {
      map[key].sort(
        (a, b) =>
          new Date(b.stageChangedAt ?? 0).getTime() -
          new Date(a.stageChangedAt ?? 0).getTime(),
      );
    }
  }
  return map;
}

export function LiveBoard({
  projectSlug,
  stages,
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
    () => groupByStage(stages, tickets),
    [stages, tickets],
  );

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
          title: event.ticket.title,
          stage: event.ticket.stage,
          priority: event.ticket.priority ?? "medium",
          stageChangedAt:
            event.type === "ticket.transitioned" || !previous
              ? (event.at ?? new Date().toISOString())
              : previous.stageChangedAt,
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
                columnTickets.map((ticket) => (
                  <Link
                    key={ticket.slug}
                    href={`/projects/${projectSlug}/tickets/${ticket.slug}`}
                    className={`ticket-card${flashSlug === ticket.slug ? " ticket-flash" : ""}`}
                  >
                    <h3>{ticket.title}</h3>
                    <div className="meta-row">
                      <span className={`badge ${ticket.priority}`}>
                        {ticket.priority}
                      </span>
                    </div>
                  </Link>
                ))
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
