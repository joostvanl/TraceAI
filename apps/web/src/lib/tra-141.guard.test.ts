import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function read(rel: string) {
  return readFileSync(join(here, rel), "utf8");
}

describe("TRA-141 board-only activity", () => {
  it("LiveBoard renders ticket-activity and listens without skipping flash", () => {
    const board = read(join("../components/LiveBoard.tsx"));
    const css = read(join("../app/globals.css"));
    assert.match(board, /ticket-activity/);
    assert.match(board, /ticket\.activity/);
    assert.match(board, /setFlashSlug\(event\.ticket\.slug\)/);
    assert.match(board, /className="ticket-activity"/);
    assert.match(board, /claimed-agent-label/);
    assert.match(css, /\.ticket-card \.ticket-activity/);
    assert.doesNotMatch(css, /\.live-board\s*\{[^}]*overflow-x:\s*hidden/);
    assert.doesNotMatch(css, /\.board-scroller\s*\{[^}]*overflow-x:\s*hidden/);
  });

  it("shows the complete activity in a hover and focus tooltip", () => {
    const board = read(join("../components/LiveBoard.tsx"));
    const css = read(join("../app/globals.css"));
    assert.match(board, /className="ticket-activity-wrap"/);
    assert.match(board, /className="ticket-activity-tooltip"/);
    assert.match(board, /role="tooltip"/);
    assert.doesNotMatch(board, /ticket-activity-wrap"[^>]*tabIndex/);
    assert.match(css, /\.ticket-card \.ticket-activity-tooltip/);
    assert.match(css, /\.ticket-activity-wrap:hover \.ticket-activity-tooltip/);
    assert.match(
      css,
      /\.ticket-card:focus-visible \.ticket-activity-tooltip/,
    );
    assert.match(
      css,
      /\.ticket-card \.ticket-activity\s*\{[^}]*text-overflow:\s*ellipsis/s,
    );
    assert.match(
      css,
      /\.ticket-card \.ticket-activity\s*\{[^}]*white-space:\s*nowrap/s,
    );
  });

  it("ticket detail, list, and inbox do not render ticket-activity", () => {
    const detail = read(
      join("../app/projects/[slug]/tickets/[ticketSlug]/page.tsx"),
    );
    const list = read(join("../app/projects/[slug]/tickets/page.tsx"));
    const inbox = read(join("../app/inbox/page.tsx"));
    assert.doesNotMatch(detail, /ticket-activity|activityExpiresAt/);
    assert.doesNotMatch(list, /ticket-activity|activityExpiresAt/);
    assert.doesNotMatch(inbox, /ticket-activity|activityExpiresAt/);
  });
});
