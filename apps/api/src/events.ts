export type TicketEventType =
  | "ticket.created"
  | "ticket.updated"
  | "ticket.transitioned"
  | "ticket.commented"
  | "ticket.archived";

export type TicketEventTicket = {
  slug: string;
  ticket_key?: string | null;
  title: string;
  stage: string;
  priority: string;
  created_by: string | null;
  project: string;
  workflow?: string;
};

export type TicketEvent = {
  type: TicketEventType;
  project: string;
  ticket: TicketEventTicket;
  from_stage?: string;
  to_stage?: string;
  at: string;
};

type Listener = (event: TicketEvent) => void;

const listeners = new Set<Listener>();

export function publishTicketEvent(event: TicketEvent) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error("ticket event listener failed", error);
    }
  }
}

export function subscribeTicketEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function ticketEventFromMapped(
  type: TicketEventType,
  ticket: {
    slug: string;
    ticket_key?: string | null;
    title: string;
    stage: string;
    priority?: string | null;
    created_by?: string | null;
    project: string;
    workflow?: string;
  },
  extra: Partial<Pick<TicketEvent, "from_stage" | "to_stage">> = {},
): TicketEvent {
  return {
    type,
    project: ticket.project,
    ticket: {
      slug: ticket.slug,
      ticket_key: ticket.ticket_key ?? null,
      title: ticket.title,
      stage: ticket.stage,
      priority: ticket.priority ?? "medium",
      created_by: ticket.created_by ?? null,
      project: ticket.project,
      workflow: ticket.workflow,
    },
    ...extra,
    at: new Date().toISOString(),
  };
}
