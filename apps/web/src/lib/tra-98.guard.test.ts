import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "../app/globals.css"), "utf8");

function block(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing ${startMarker}`);
  const from = start + startMarker.length;
  const end = source.indexOf(endMarker, from);
  assert.ok(end >= 0, `missing ${endMarker} after ${startMarker}`);
  return source.slice(from, end);
}

describe("TRA-98 board columns stay in one desktop row", () => {
  it("desktop board is a non-wrapping column track with a themed bottom scroller", () => {
    const desktop = block(css, "\n.board {", "\n}");
    assert.match(desktop, /grid-auto-flow:\s*column/);
    assert.match(desktop, /grid-auto-columns:\s*minmax\(200px,\s*1fr\)/);
    assert.doesNotMatch(desktop, /auto-fit/);

    const scroller = block(css, "\n.board-scroller {", "\n}");
    assert.match(scroller, /overflow-x:\s*auto/);
    assert.match(scroller, /flex:\s*1/);
    assert.match(scroller, /scrollbar-color:\s*var\(--border\)\s*var\(--bg\)/);
  });

  it("board page fills the project pane so the scrollbar sits at the bottom", () => {
    assert.match(css, /\.project-shell-main:has\(\.live-board\)/);
    assert.match(css, /body:has\(\.project-shell\)/);
  });

  it("mobile board stacks columns at the project-shell breakpoint", () => {
    const mobile = block(css, "@media (max-width: 640px) {", "\n.form-error {");
    const board = block(mobile, "\n  .board {", "\n  }");
    assert.match(board, /grid-auto-flow:\s*row/);
    assert.match(board, /grid-template-columns:\s*1fr/);
    const scroller = block(mobile, "\n  .board-scroller {", "\n  }");
    assert.match(scroller, /overflow-x:\s*visible/);
  });
});
