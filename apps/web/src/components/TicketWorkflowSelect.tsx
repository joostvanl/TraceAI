"use client";

import { useRouter } from "next/navigation";
import { useState, type ChangeEvent } from "react";

export type TicketWorkflowOption = {
  slug: string;
  name: string;
  isDefault?: boolean;
};

type Props = {
  ticketSlug: string;
  currentSlug: string;
  currentLabel: string;
  options: TicketWorkflowOption[];
  canChange: boolean;
  disabledReason?: string;
};

export function TicketWorkflowSelect({
  ticketSlug,
  currentSlug,
  currentLabel,
  options,
  canChange,
  disabledReason,
}: Props) {
  const router = useRouter();
  const [value, setValue] = useState(currentSlug);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!canChange) {
    return (
      <span className="badge" title={disabledReason}>
        {currentLabel}
      </span>
    );
  }

  async function onChange(event: ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value;
    const selected = options.find((o) => o.slug === next);
    const label = selected
      ? `${selected.name}${selected.isDefault ? " (default)" : ""}`
      : next;
    if (next === currentSlug) {
      setValue(next);
      return;
    }
    if (
      !window.confirm(
        `Verplaats dit ticket naar “${label}”? Het verdwijnt van het huidige board.`,
      )
    ) {
      event.target.value = value;
      return;
    }
    setError(null);
    setPending(true);
    try {
      const res = await fetch(`/api/tickets/${encodeURIComponent(ticketSlug)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow: next }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setError(body.message ?? `Update failed (${res.status})`);
        event.target.value = value;
        return;
      }
      setValue(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      event.target.value = value;
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="ticket-workflow-control">
      <select
        className="ticket-workflow-select"
        value={value}
        disabled={pending}
        aria-label="Workflow"
        onChange={onChange}
      >
        {options.map((option) => (
          <option key={option.slug} value={option.slug}>
            {option.name}
            {option.isDefault ? " (default)" : ""}
          </option>
        ))}
      </select>
      {error ? <span className="ticket-workflow-select-error">{error}</span> : null}
    </span>
  );
}
