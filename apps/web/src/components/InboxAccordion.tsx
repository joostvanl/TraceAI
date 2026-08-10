"use client";

import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";

type AccordionContextValue = {
  openId: string | null;
  setOpenId: (id: string | null) => void;
};

const AccordionContext = createContext<AccordionContextValue | null>(null);

export function InboxAccordion({
  children,
  initialOpenId = null,
}: {
  children: ReactNode;
  initialOpenId?: string | null;
}) {
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  return (
    <AccordionContext.Provider value={{ openId, setOpenId }}>
      <div className="inbox-list">{children}</div>
    </AccordionContext.Provider>
  );
}

export function InboxAccordionItem({
  id,
  ticketKey,
  title,
  stageName,
  project,
  awaiting,
  children,
}: {
  id: string;
  ticketKey: string | null;
  title: string;
  stageName: string;
  project: string;
  awaiting: "verdict" | "agent";
  children: ReactNode;
}) {
  const ctx = useContext(AccordionContext);
  if (!ctx) {
    throw new Error("InboxAccordionItem must be used inside InboxAccordion");
  }
  const open = ctx.openId === id;

  return (
    <section
      className={`panel inbox-ticket${open ? " is-open" : ""}`}
      id={id}
    >
      <button
        type="button"
        className="inbox-ticket-summary"
        aria-expanded={open}
        onClick={() => ctx.setOpenId(open ? null : id)}
      >
        <span className="inbox-ticket-summary-main">
          {ticketKey ? (
            <span className="ticket-key">{ticketKey}</span>
          ) : (
            <code>{id}</code>
          )}
          <span className="inbox-ticket-title">{title}</span>
        </span>
        <span className="inbox-ticket-summary-meta">
          <span className="badge">{stageName}</span>
          <span className="badge">
            {awaiting === "verdict" ? "Wacht op oordeel" : "Agent rondt af"}
          </span>
          <span className="muted">{project}</span>
          <span className="inbox-chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
        </span>
      </button>
      {open ? <div className="inbox-ticket-body">{children}</div> : null}
    </section>
  );
}
