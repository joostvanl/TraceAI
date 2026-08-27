import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = dirname(here);
const appDir = join(srcDir, "app");

function read(rel: string): string {
  return readFileSync(join(srcDir, rel), "utf8");
}

/** Ticket-detail href immediately followed by prefetch={false}. */
const ticketHrefThenPrefetch =
  /href=\{`\/projects\/\$\{[^}]+\}\/tickets\/\$\{[^}]+\}`\}\s+prefetch=\{false\}/g;

function ticketHrefCount(source: string): number {
  return (source.match(/href=\{`\/projects\/\$\{[^}]+\}\/tickets\/\$\{[^}]+\}`\}/g) ?? [])
    .length;
}

function prefetchTicketHrefCount(source: string): number {
  return (source.match(ticketHrefThenPrefetch) ?? []).length;
}

function collectPageFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectPageFiles(full, acc);
    } else if (name === "page.tsx" || name === "page.ts") {
      acc.push(full);
    }
  }
  return acc;
}

describe("TRA-126 ticket detail refresh on open", () => {
  it("ticket detail keeps force-dynamic, fetchCache force-no-store, and TicketDetailRefresh", () => {
    const detail = read(
      "app/projects/[slug]/tickets/[ticketSlug]/page.tsx",
    );
    assert.match(detail, /export const dynamic = "force-dynamic"/);
    assert.match(detail, /export const fetchCache = "force-no-store"/);
    assert.match(detail, /TicketDetailRefresh/);
    assert.match(
      detail,
      /<TicketDetailRefresh ticketSlug=\{ticket\.slug\} \/>/,
    );
    assert.doesNotMatch(detail, /EventSource/);
    assert.doesNotMatch(detail, /setInterval/);
    assert.doesNotMatch(detail, /new EventSource/);
  });

  it("TicketDetailRefresh calls router.refresh on show and pageshow, without poll or SSE", () => {
    const refresh = read("components/TicketDetailRefresh.tsx");
    assert.match(refresh, /"use client"/);
    assert.match(refresh, /useRouter/);
    assert.match(refresh, /router\.refresh\(\)/);
    assert.match(refresh, /addEventListener\("pageshow"/);
    assert.match(refresh, /event\.persisted/);
    assert.match(refresh, /\[router, ticketSlug\]/);
    assert.doesNotMatch(refresh, /EventSource/);
    assert.doesNotMatch(refresh, /setInterval/);
    assert.doesNotMatch(refresh, /setTimeout/);
  });

  it("LiveBoard ticket cards disable hover prefetch", () => {
    const board = read("components/LiveBoard.tsx");
    assert.equal(ticketHrefCount(board), 1);
    assert.equal(prefetchTicketHrefCount(board), 1);
    assert.match(
      board,
      /href=\{`\/projects\/\$\{projectSlug\}\/tickets\/\$\{ticket\.slug\}`\}\s+prefetch=\{false\}/,
    );
  });

  it("inbound ticket lists disable hover prefetch", () => {
    const tickets = read("app/projects/[slug]/tickets/page.tsx");
    const inbox = read("app/inbox/page.tsx");
    const insights = read("app/projects/[slug]/insights/page.tsx");

    assert.equal(ticketHrefCount(tickets), 2);
    assert.equal(prefetchTicketHrefCount(tickets), 2);

    assert.equal(ticketHrefCount(inbox), 1);
    assert.equal(prefetchTicketHrefCount(inbox), 1);

    assert.equal(ticketHrefCount(insights), 3);
    assert.equal(prefetchTicketHrefCount(insights), 3);
    assert.match(
      insights,
      /href=\{`\/projects\/\$\{slug\}\/wiki\/\$\{hit\.slug\}`\}/,
    );
    assert.doesNotMatch(
      insights,
      /href=\{`\/projects\/\$\{slug\}\/wiki\/\$\{hit\.slug\}`\}\s+prefetch=\{false\}/,
    );
  });

  it("fetchCache force-no-store is only on the ticket-detail page", () => {
    const detailRel = join(
      "projects",
      "[slug]",
      "tickets",
      "[ticketSlug]",
      "page.tsx",
    );
    for (const file of collectPageFiles(appDir)) {
      const rel = relative(appDir, file);
      const source = readFileSync(file, "utf8");
      if (rel === detailRel) {
        assert.match(source, /export const fetchCache = "force-no-store"/);
        continue;
      }
      assert.doesNotMatch(
        source,
        /export const fetchCache/,
        `${rel} must not set fetchCache`,
      );
    }
  });
});
