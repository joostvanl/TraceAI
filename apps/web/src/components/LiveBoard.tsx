"use client";

import Link from "next/link";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
} from "react";
import { groupByStage, moveItem } from "@/lib/board-order";
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
  /** Human verdict on the current human-gated stage, if one was given. */
  reviewState?: string | null;
  /** Vertical order within a stage (first column). */
  sortOrder?: number | null;
};

export type BoardStage = {
  key: string;
  name: string;
  requiresHumanApproval?: boolean;
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
    review_state?: string | null;
    sort_order?: number | null;
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
  /** When true, first-column cards are vertically reorderable. */
  canReorder?: boolean;
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

/**
 * Review state of a card in a human-gated column: waiting for a verdict, or
 * carrying one while the agent still has to make the move.
 */
function reviewBadge(
  stage: BoardStage,
  ticket: BoardTicket,
): { label: string; cardClass: string; badgeClass: string } | null {
  if (stage.requiresHumanApproval !== true) return null;
  if (ticket.reviewState === "approved") {
    return {
      label: "Goedgekeurd — agent rondt af",
      cardClass: "ticket-review-approved",
      badgeClass: "review-approved-badge",
    };
  }
  if (ticket.reviewState === "rejected") {
    return {
      label: "Afgekeurd — agent pakt op",
      cardClass: "ticket-review-rejected",
      badgeClass: "review-rejected-badge",
    };
  }
  return {
    label: "Wacht op beoordeling",
    cardClass: "ticket-awaiting-human",
    badgeClass: "human-gate-badge",
  };
}

export function LiveBoard({
  projectSlug,
  stages,
  lastStageKey,
  initialTickets,
  eventsUrl,
  canReorder = false,
}: Props) {
  const [tickets, setTickets] = useState<BoardTicket[]>(initialTickets);
  const [flashSlug, setFlashSlug] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<"connecting" | "live" | "offline">(
    "connecting",
  );
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [lastEventId, setLastEventId] = useState<string | null>(null);
  const [draggingSlug, setDraggingSlug] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const [persisting, setPersisting] = useState(false);
  const suppressClickRef = useRef(false);
  const dragFromIndexRef = useRef<number | null>(null);

  const reorderableStageKey = stages[0]?.key;
  const reorderEnabled = canReorder && Boolean(reorderableStageKey);

  const ticketsByStage = useMemo(() => {
    const map = groupByStage(stages, tickets, reorderableStageKey);
    if (lastStageKey && map[lastStageKey]) {
      map[lastStageKey] = newestFirstCapped(
        map[lastStageKey],
        (t) => t.stageChangedAt,
      );
    }
    return map;
  }, [stages, tickets, lastStageKey, reorderableStageKey]);

  // Events are now durable and cross-process: writes to any API instance land
  // in the shared store, and this stream replays anything missed on reconnect
  // via Last-Event-ID. Shown only as a diagnostic hint.
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

      // The browser resends this as `Last-Event-ID` on reconnect, so the API
      // replays only events newer than this id — no full refresh needed.
      if (raw.lastEventId) setLastEventId(raw.lastEventId);
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
          // A transition always clears the verdict server-side; every other
          // event carries the current one.
          reviewState:
            event.type === "ticket.transitioned"
              ? null
              : (event.ticket.review_state ?? null),
          sortOrder:
            event.ticket.sort_order !== undefined
              ? event.ticket.sort_order
              : (previous?.sortOrder ?? null),
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
    source.addEventListener("ticket.reviewed", applyEvent);

    source.onopen = () => setLiveState("live");
    source.onerror = () => setLiveState("offline");

    return () => {
      if (flashTimer) clearTimeout(flashTimer);
      source.close();
    };
  }, [eventsUrl, projectSlug]);

  async function persistReorder(
    stageKey: string,
    ordered: BoardTicket[],
    previousTickets: BoardTicket[],
  ) {
    setPersisting(true);
    setReorderError(null);
    try {
      const res = await fetch("/api/tickets/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: projectSlug,
          stage: stageKey,
          ordered_slugs: ordered.map((t) => t.slug),
        }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(payload?.message || `Reorder failed (${res.status})`);
      }
      // Apply canonical indices so local state matches the server.
      setTickets((prev) => {
        const orderBySlug = new Map(
          ordered.map((t, index) => [t.slug, index] as const),
        );
        return prev.map((t) => {
          const nextOrder = orderBySlug.get(t.slug);
          if (nextOrder === undefined) return t;
          return { ...t, sortOrder: nextOrder };
        });
      });
    } catch (error) {
      setTickets(previousTickets);
      setReorderError(
        error instanceof Error ? error.message : "Could not save new order",
      );
    } finally {
      setPersisting(false);
    }
  }

  function onCardDragStart(
    event: DragEvent<HTMLAnchorElement>,
    stageKey: string,
    index: number,
    slug: string,
  ) {
    if (!reorderEnabled || stageKey !== reorderableStageKey || persisting) {
      event.preventDefault();
      return;
    }
    dragFromIndexRef.current = index;
    setDraggingSlug(slug);
    setDropIndex(index);
    setReorderError(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", slug);
  }

  function onCardDragOver(
    event: DragEvent<HTMLElement>,
    stageKey: string,
    index: number,
  ) {
    if (!reorderEnabled || stageKey !== reorderableStageKey) return;
    if (draggingSlug == null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropIndex(index);
  }

  function onColumnDragOver(event: DragEvent<HTMLElement>, stageKey: string) {
    if (!reorderEnabled || stageKey !== reorderableStageKey) return;
    if (draggingSlug == null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  function onCardDrop(
    event: DragEvent<HTMLElement>,
    stageKey: string,
    toIndex: number,
  ) {
    event.preventDefault();
    void finishDrop(stageKey, toIndex);
  }

  function onColumnDrop(event: DragEvent<HTMLElement>, stageKey: string) {
    event.preventDefault();
    const column = ticketsByStage[stageKey] ?? [];
    void finishDrop(stageKey, Math.max(0, column.length - 1));
  }

  async function finishDrop(stageKey: string, toIndex: number) {
    const fromIndex = dragFromIndexRef.current;
    setDraggingSlug(null);
    setDropIndex(null);
    dragFromIndexRef.current = null;
    if (
      !reorderEnabled ||
      stageKey !== reorderableStageKey ||
      fromIndex == null ||
      fromIndex === toIndex
    ) {
      return;
    }
    suppressClickRef.current = true;
    const column = ticketsByStage[stageKey] ?? [];
    const reordered = moveItem(column, fromIndex, toIndex);
    if (reordered === column) return;

    const previousTickets = tickets;
    const optimistic = tickets.map((t) => {
      const idx = reordered.findIndex((r) => r.slug === t.slug);
      if (idx < 0) return t;
      return { ...t, sortOrder: idx };
    });
    setTickets(optimistic);
    await persistReorder(stageKey, reordered, previousTickets);
  }

  function onCardDragEnd() {
    setDraggingSlug(null);
    setDropIndex(null);
    dragFromIndexRef.current = null;
  }

  function onCardClick(event: MouseEvent<HTMLAnchorElement>) {
    if (suppressClickRef.current) {
      event.preventDefault();
      suppressClickRef.current = false;
    }
  }

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
          {lastEventId ? ` · #${lastEventId}` : null}
          {persisting ? " · saving order…" : null}
        </span>
      </div>
      {reorderError ? (
        <p className="board-reorder-error" role="alert">
          {reorderError}
        </p>
      ) : null}

      <div className="board">
        {stages.map((stage) => {
          const columnTickets = ticketsByStage[stage.key] ?? [];
          const isReorderColumn =
            reorderEnabled && stage.key === reorderableStageKey;
          return (
            <section
              key={stage.key}
              className={`column${stage.requiresHumanApproval ? " column-human-gate" : ""}${isReorderColumn ? " column-reorderable" : ""}`}
              onDragOver={
                isReorderColumn
                  ? (e) => onColumnDragOver(e, stage.key)
                  : undefined
              }
              onDrop={
                isReorderColumn ? (e) => onColumnDrop(e, stage.key) : undefined
              }
            >
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
                columnTickets.map((ticket, index) => {
                  const tokens = tokenLabel(ticket);
                  const showResolution =
                    Boolean(ticket.resolution) &&
                    (lastStageKey == null || stage.key === lastStageKey);
                  const review = reviewBadge(stage, ticket);
                  const isDragging = draggingSlug === ticket.slug;
                  const showDropBefore =
                    isReorderColumn &&
                    dropIndex === index &&
                    draggingSlug != null &&
                    draggingSlug !== ticket.slug;
                  return (
                    <div key={ticket.slug} className="ticket-slot">
                      {showDropBefore ? (
                        <div className="ticket-drop-indicator" aria-hidden />
                      ) : null}
                      <Link
                        href={`/projects/${projectSlug}/tickets/${ticket.slug}`}
                        className={`ticket-card${review ? ` ${review.cardClass}` : ""}${flashSlug === ticket.slug ? " ticket-flash" : ""}${isReorderColumn ? " ticket-reorderable" : ""}${isDragging ? " ticket-dragging" : ""}`}
                        draggable={isReorderColumn && !persisting}
                        onDragStart={
                          isReorderColumn
                            ? (e) =>
                                onCardDragStart(e, stage.key, index, ticket.slug)
                            : undefined
                        }
                        onDragOver={
                          isReorderColumn
                            ? (e) => onCardDragOver(e, stage.key, index)
                            : undefined
                        }
                        onDrop={
                          isReorderColumn
                            ? (e) => onCardDrop(e, stage.key, index)
                            : undefined
                        }
                        onDragEnd={isReorderColumn ? onCardDragEnd : undefined}
                        onClick={onCardClick}
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
                          {review ? (
                            <span className={`badge ${review.badgeClass}`}>
                              {review.label}
                            </span>
                          ) : null}
                          {tokens ? (
                            <span
                              className="muted"
                              style={{ fontSize: "0.75rem" }}
                            >
                              {tokens}
                            </span>
                          ) : null}
                        </div>
                      </Link>
                    </div>
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
