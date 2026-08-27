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
import {
  UNMAPPED_STAGE_KEY,
  claimedAgentLabel,
  newestFirstCapped,
  remapStageForBoard,
} from "@traceai/core";
import { groupByStage, moveItem } from "@/lib/board-order";
import {
  applyBoardTicketEvent,
  type BoardTicket,
  type BoardTicketEvent,
} from "@/lib/board-events";

export type { BoardTicket } from "@/lib/board-events";

export type BoardStage = {
  key: string;
  name: string;
  requiresHumanApproval?: boolean;
};

type Props = {
  projectSlug: string;
  selectedWorkflow: string;
  defaultWorkflow: string | null;
  projectWorkflowSlugs: string[];
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
  selectedWorkflow,
  defaultWorkflow,
  projectWorkflowSlugs,
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

  const liveStageKeys = useMemo(
    () => stages.map((s) => s.key).filter((key) => key !== UNMAPPED_STAGE_KEY),
    [stages],
  );
  const boardStages = useMemo(() => {
    const hasOverflow = tickets.some(
      (t) => remapStageForBoard(t.stage, liveStageKeys) === UNMAPPED_STAGE_KEY,
    );
    const without = stages.filter((s) => s.key !== UNMAPPED_STAGE_KEY);
    return hasOverflow
      ? [...without, { key: UNMAPPED_STAGE_KEY, name: "Onbekende stage" }]
      : without;
  }, [stages, tickets, liveStageKeys]);
  const reorderableStageKey = boardStages[0]?.key;
  const reorderEnabled =
    canReorder &&
    Boolean(reorderableStageKey) &&
    reorderableStageKey !== UNMAPPED_STAGE_KEY;

  const ticketsByStage = useMemo(() => {
    const displayTickets = tickets.map((t) => ({
      ...t,
      stage: remapStageForBoard(t.stage, liveStageKeys),
    }));
    const map = groupByStage(boardStages, displayTickets, reorderableStageKey);
    if (lastStageKey && map[lastStageKey]) {
      map[lastStageKey] = newestFirstCapped(
        map[lastStageKey],
        (t) => t.stageChangedAt,
      );
    }
    return map;
  }, [boardStages, tickets, lastStageKey, reorderableStageKey, liveStageKeys]);

  // Events are now durable and cross-process: writes to any API instance land
  // in the shared store, and this stream replays anything missed on reconnect
  // via Last-Event-ID. Shown only as a diagnostic hint.
  const eventsHost = useMemo(() => {
    try {
      const origin =
        typeof window !== "undefined"
          ? window.location.origin
          : "http://localhost";
      return new URL(eventsUrl, origin).host;
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

    const url = new URL(eventsUrl, window.location.origin);
    url.searchParams.set("project", projectSlug);
    const source = new EventSource(url.toString());
    let flashTimer: ReturnType<typeof setTimeout> | undefined;

    const applyEvent = (raw: MessageEvent) => {
      let event: BoardTicketEvent;
      try {
        event = JSON.parse(String(raw.data)) as BoardTicketEvent;
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

      setTickets((prev) =>
        applyBoardTicketEvent(prev, event, {
          projectSlug,
          selectedWorkflow,
          defaultWorkflow,
          projectWorkflowSlugs,
        }),
      );

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
  }, [eventsUrl, projectSlug, selectedWorkflow, defaultWorkflow, projectWorkflowSlugs]);

  async function persistReorder(
    stageKey: string,
    ordered: BoardTicket[],
    previousTickets: BoardTicket[],
  ) {
    setPersisting(true);
    setReorderError(null);
    try {
      const ordered_slugs = ordered.filter((t) => !t.orphan).map((t) => t.slug);
      if (ordered_slugs.length === 0) return;
      const res = await fetch("/api/tickets/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: projectSlug,
          stage: stageKey,
          workflow: selectedWorkflow,
          ordered_slugs,
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
    if (
      !reorderEnabled ||
      stageKey !== reorderableStageKey ||
      persisting ||
      tickets.find((t) => t.slug === slug)?.orphan
    ) {
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
    const dragged = column[fromIndex];
    if (!dragged || dragged.orphan) return;
    const reordered = moveItem(column, fromIndex, toIndex);
    if (reordered === column) return;
    const pinned = reordered.filter((t) => !t.orphan);
    if (pinned.length === 0) return;

    const previousTickets = tickets;
    const optimistic = tickets.map((t) => {
      const idx = pinned.findIndex((r) => r.slug === t.slug);
      if (idx < 0) return t;
      return { ...t, sortOrder: idx };
    });
    setTickets(optimistic);
    await persistReorder(stageKey, pinned, previousTickets);
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

      <div className="board-scroller">
        <div className="board">
        {boardStages.map((stage) => {
          const columnTickets = ticketsByStage[stage.key] ?? [];
          const isReorderColumn =
            reorderEnabled &&
            stage.key === reorderableStageKey &&
            stage.key !== UNMAPPED_STAGE_KEY;
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
                  const claimLabel = claimedAgentLabel(ticket.claimedAgentId);
                  const isDragging = draggingSlug === ticket.slug;
                  const cardReorderable =
                    isReorderColumn && !ticket.orphan && !persisting;
                  const showDropBefore =
                    cardReorderable &&
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
                        prefetch={false}
                        className={`ticket-card${review ? ` ${review.cardClass}` : ""}${flashSlug === ticket.slug ? " ticket-flash" : ""}${cardReorderable ? " ticket-reorderable" : ""}${ticket.orphan ? " ticket-orphan" : ""}${isDragging ? " ticket-dragging" : ""}`}
                        draggable={cardReorderable}
                        onDragStart={
                          cardReorderable
                            ? (e) =>
                                onCardDragStart(e, stage.key, index, ticket.slug)
                            : undefined
                        }
                        onDragOver={
                          isReorderColumn && !ticket.orphan
                            ? (e) => onCardDragOver(e, stage.key, index)
                            : undefined
                        }
                        onDrop={
                          isReorderColumn && !ticket.orphan
                            ? (e) => onCardDrop(e, stage.key, index)
                            : undefined
                        }
                        onDragEnd={cardReorderable ? onCardDragEnd : undefined}
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
                          {claimLabel ? (
                            <span
                              className="badge claimed-agent-label"
                              title={ticket.claimedAgentId ?? undefined}
                            >
                              {claimLabel}
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
    </div>
  );
}
