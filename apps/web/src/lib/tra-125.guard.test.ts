import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = dirname(here);

function read(rel: string): string {
  return readFileSync(join(srcDir, rel), "utf8");
}

describe("TRA-125 copy claimed agent id", () => {
  it("ticket detail copies the raw id via CopyClaimedAgentIdButton", () => {
    const detail = read(
      "app/projects/[slug]/tickets/[ticketSlug]/page.tsx",
    );
    const button = read("components/CopyClaimedAgentIdButton.tsx");
    const helper = read("lib/copy-claimed-agent-id.ts");

    assert.match(detail, /CopyClaimedAgentIdButton/);
    assert.match(
      detail,
      /<CopyClaimedAgentIdButton\s+agentId=\{ticket\.fields\.claimed_agent_id\}/,
    );
    assert.match(detail, /claimedAgentLabel/);
    assert.match(detail, /const claimedLabel = claimedAgentLabel/);
    assert.doesNotMatch(detail, /clipboard/);

    assert.match(button, /normalizeClaimedAgentId/);
    assert.match(button, /copyClaimedAgentId/);
    assert.match(button, /className="btn btn-small copy-claimed-agent-id"/);
    assert.match(button, /Copied/);
    assert.doesNotMatch(button, /claimedAgentLabel/);

    assert.match(helper, /normalizeClaimedAgentId\(raw\)/);
    assert.match(helper, /writeText\(id\)/);
    assert.doesNotMatch(helper, /claimedAgentLabel/);
  });

  it("LiveBoard has no copy control and keeps the TRA-112 badge", () => {
    const board = read("components/LiveBoard.tsx");
    assert.match(board, /claimedAgentLabel/);
    assert.match(board, /className="badge claimed-agent-label"/);
    assert.match(board, /title=\{ticket\.claimedAgentId/);
    assert.doesNotMatch(board, /CopyClaimedAgentId/);
    assert.doesNotMatch(board, /copyClaimedAgentId/);
    assert.doesNotMatch(board, /clipboard/);
    assert.doesNotMatch(board, /copy-claimed-agent-id/);
    assert.doesNotMatch(board, /Copy id/);
  });

  it("claimedAgentLabel still truncates ids longer than 14 characters", () => {
    const source = readFileSync(
      join(here, "../../../../packages/core/src/claimed-agent.ts"),
      "utf8",
    );
    assert.match(
      source,
      /const shown = id\.length > 14 \? `\$\{id\.slice\(0, 12\)\}…` : id/,
    );
  });
});
