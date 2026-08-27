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

describe("TRA-127 Cursor panel + display name surfaces", () => {
  it("Agent APIs is one Cursor panel with two save actions and no name/project picker", () => {
    const source = read("components/AccountAgentApisPanel.tsx");
    const headings = [...source.matchAll(/<h3\b[^>]*>([^<]*)<\/h3>/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(headings, ["Cursor", "Later"]);
    assert.match(source, /\/api\/account\/agent-apis/);
    assert.match(source, /JSON\.stringify\(\{\s*provider: "cursor",\s*api_key: cursorKey/);
    assert.doesNotMatch(source, /\/api\/account\/default-agent/);
    assert.doesNotMatch(source, /weergavenaam/i);
    assert.doesNotMatch(source, /display_name/);
    assert.doesNotMatch(source, /displayName/);
    assert.doesNotMatch(source, /project picker/i);
    assert.doesNotMatch(source, /\/api\/account\/.*agents/);
    assert.doesNotMatch(source, /<select/);
  });

  it("board and ticket detail pass displayName into claimedAgentLabel", () => {
    const board = read("components/LiveBoard.tsx");
    const detail = read(
      "app/projects/[slug]/tickets/[ticketSlug]/page.tsx",
    );
    assert.match(board, /claimedAgentLabel\(/);
    assert.match(board, /ticket\.claimedAgentDisplayName/);
    assert.match(detail, /displayNameForCursorAgentId/);
    assert.match(detail, /CopyClaimedAgentIdButton/);
    assert.match(
      detail,
      /<CopyClaimedAgentIdButton\s+agentId=\{ticket\.fields\.claimed_agent_id\}/,
    );
  });

  it("inbox, insights, tickets-list, and comment author do not show the weergavenaam", () => {
    const inbox = read("app/inbox/page.tsx");
    const insights = read("app/projects/[slug]/insights/page.tsx");
    const ticketsList = read("app/projects/[slug]/tickets/page.tsx");
    assert.doesNotMatch(inbox, /claimedAgentLabel/);
    assert.doesNotMatch(inbox, /claimedAgentDisplayName/);
    assert.doesNotMatch(insights, /claimedAgentLabel/);
    assert.doesNotMatch(insights, /claimed_agent_display_name/);
    assert.doesNotMatch(ticketsList, /claimedAgentLabel/);
    assert.doesNotMatch(ticketsList, /claimedAgentDisplayName/);
  });

  it("first-paint snapshot threads claimed_agent_display_name", () => {
    const cms = read("lib/cms.ts");
    assert.match(
      cms,
      /claimedAgentDisplayName: t\.claimed_agent_display_name\?\.trim\(\) \|\| null/,
    );
    assert.match(cms, /claimed_agent_display_name\?: string \| null/);
    const page = read("app/projects/[slug]/page.tsx");
    assert.match(page, /claimedAgentDisplayName: displayNameForCursorAgentId/);
  });
});
