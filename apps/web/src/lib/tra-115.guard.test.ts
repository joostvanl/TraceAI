import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "../app/globals.css"), "utf8");
const rootLayout = readFileSync(join(here, "../app/layout.tsx"), "utf8");
const projectLayout = readFileSync(
  join(here, "../app/projects/[slug]/layout.tsx"),
  "utf8",
);

function block(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing ${startMarker}`);
  const from = start + startMarker.length;
  const end = source.indexOf(endMarker, from);
  assert.ok(end >= 0, `missing ${endMarker} after ${startMarker}`);
  return source.slice(from, end);
}

describe("TRA-115 mobile board and ticket-detail stay in the viewport", () => {
  const mobile = block(css, "@media (max-width: 640px) {", "\n.form-error {");

  it("root layout pins a device-width viewport and wraps header actions", () => {
    assert.match(rootLayout, /export const viewport/);
    assert.match(rootLayout, /width:\s*"device-width"/);
    assert.match(rootLayout, /className="site-header-brand"/);
    assert.match(rootLayout, /className="site-main"/);
  });

  it("project shell markup still uses the constrained chrome classes", () => {
    assert.match(projectLayout, /className="project-shell"/);
    assert.match(projectLayout, /className="project-shell-main"/);
  });

  it("mobile chrome is width-contained without clipping the board pane", () => {
    assert.match(
      mobile,
      /\.site-header,\s*\n\s*\.site-main,\s*\n\s*\.project-shell,\s*\n\s*\.project-shell-main \{[^}]*max-width:\s*100%[^}]*min-width:\s*0/,
    );
    assert.match(mobile, /\.auth-status \{[^}]*max-width:\s*100%/);
    assert.match(
      mobile,
      /\.ticket-detail,\s*\n\s*\.ticket-detail \.panel \{[^}]*max-width:\s*100%/,
    );
    assert.match(mobile, /\.ticket-detail \.panel \{[^}]*overflow-x:\s*auto/);

    const liveBoard = block(mobile, "\n  .live-board {", "\n  }");
    assert.match(liveBoard, /overflow:\s*visible/);
    assert.match(liveBoard, /max-width:\s*100%/);
    assert.doesNotMatch(liveBoard, /overflow-x:\s*hidden/);

    const scroller = block(mobile, "\n  .board-scroller {", "\n  }");
    assert.match(scroller, /overflow-x:\s*visible/);
    assert.match(scroller, /max-width:\s*100%/);
    assert.doesNotMatch(scroller, /overflow-x:\s*hidden/);
  });

  it("desktop board scroller stays the TRA-98 scrollport", () => {
    const desktop = block(css, "\n.board {", "\n}");
    assert.match(desktop, /grid-auto-flow:\s*column/);
    assert.match(desktop, /grid-auto-columns:\s*minmax\(200px,\s*1fr\)/);

    const scroller = block(css, "\n.board-scroller {", "\n}");
    assert.match(scroller, /overflow-x:\s*auto/);
    assert.doesNotMatch(scroller, /overflow-x:\s*hidden/);
  });
});
