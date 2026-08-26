import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

describe("TRA-112 claimed agent on board card", () => {
  it("board and ticket detail share claimedAgentLabel", () => {
    const board = readFileSync(
      join(here, "../components/LiveBoard.tsx"),
      "utf8",
    );
    const detail = readFileSync(
      join(here, "../app/projects/[slug]/tickets/[ticketSlug]/page.tsx"),
      "utf8",
    );
    assert.match(board, /claimedAgentLabel/);
    assert.match(board, /claimLabel/);
    assert.match(board, /className="badge claimed-agent-label"/);
    assert.match(board, /title=\{ticket\.claimedAgentId/);
    assert.match(detail, /claimedAgentLabel/);
    assert.match(detail, /const claimedLabel = claimedAgentLabel/);
    assert.doesNotMatch(board, /unclaimed/i);
    assert.doesNotMatch(detail, /claimedAgentKind/);
  });

  it("first-paint snapshot and Aurora fallback thread claimedAgentId", () => {
    const cms = readFileSync(join(here, "cms.ts"), "utf8");
    const page = readFileSync(
      join(here, "../app/projects/[slug]/page.tsx"),
      "utf8",
    );
    assert.match(cms, /claimedAgentId: t\.claimed_agent_id\?\.trim\(\) \|\| null/);
    assert.match(cms, /claimed_agent_id\?: string \| null/);
    assert.match(
      page,
      /claimedAgentId: ticket\.fields\.claimed_agent_id\?\.trim\(\) \|\| null/,
    );
  });

  it("does not add claim fields to live SSE mapping", () => {
    const events = readFileSync(
      join(here, "../../../api/src/events.ts"),
      "utf8",
    );
    const start = events.indexOf("export function ticketEventFromMapped");
    assert.ok(start >= 0);
    const next = events.indexOf("\nexport ", start + 1);
    const fn = events.slice(start, next === -1 ? undefined : next);
    assert.doesNotMatch(fn, /claimed_agent/);
  });
});
