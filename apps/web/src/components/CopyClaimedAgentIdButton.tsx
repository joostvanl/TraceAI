"use client";

import { useEffect, useState } from "react";
import { normalizeClaimedAgentId } from "@traceai/core";
import { copyClaimedAgentId } from "@/lib/copy-claimed-agent-id";

type Props = {
  agentId: string | null | undefined;
};

export function CopyClaimedAgentIdButton({ agentId }: Props) {
  const rawId = normalizeClaimedAgentId(agentId);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!rawId) return null;

  async function onClick() {
    const result = await copyClaimedAgentId(rawId, (text) =>
      navigator.clipboard.writeText(text),
    );
    setCopied(result === "copied");
  }

  return (
    <button
      type="button"
      className="btn btn-small copy-claimed-agent-id"
      onClick={() => void onClick()}
      aria-label="Copy claimed agent id"
    >
      {copied ? "Copied" : "Copy id"}
    </button>
  );
}
