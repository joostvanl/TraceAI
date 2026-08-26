import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "../app/globals.css"), "utf8");
const rules = css.replace(/\/\*[\s\S]*?\*\//g, " ");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function braceBody(source: string, start: number): string {
  let depth = 1;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i);
    }
  }
  assert.fail("unclosed CSS block");
}

/** First @media (max-width: 640px) body — brace-matched, not a source-string slice. */
function mobile640(source: string): string {
  const open = /@media\s*\(\s*max-width:\s*640px\s*\)\s*\{/i.exec(source);
  assert.ok(open, "missing @media (max-width: 640px)");
  return braceBody(source, open.index + open[0].length);
}

/**
 * Declaration body of the first rule whose selector list includes `ident`
 * as a whole CSS ident (`.board` will not match `.board-scroller`).
 * Combined selectors (`.foo, .board-scroller`) are allowed.
 */
function declsFor(source: string, ident: string): string {
  const token = escapeRegExp(ident);
  const re = new RegExp(`(?:^|[,{\\s])${token}(?![\\w-])[^{]*\\{`);
  const match = re.exec(source);
  assert.ok(match, `missing rule containing ${ident}`);
  return braceBody(source, match.index + match[0].length);
}

function hasDecl(body: string, property: string, valuePattern: string): void {
  const re = new RegExp(
    `${escapeRegExp(property)}\\s*:\\s*${valuePattern}`,
    "i",
  );
  assert.match(body, re, `expected ${property}: ${valuePattern}`);
}

function hasNoOverflowXHidden(body: string, label: string): void {
  assert.doesNotMatch(
    body,
    /overflow-x\s*:\s*hidden/i,
    `${label} must not use overflow-x: hidden`,
  );
}

describe("TRA-120 overflow contract marker", () => {
  it("globals.css states the board vs page chrome contract", () => {
    assert.match(css, /TRA-120-OVERFLOW-CONTRACT/);
    assert.match(css, /page must not scroll horizontally/i);
    assert.match(
      css,
      /\.board-scroller is the only horizontal scrollport/i,
    );
    assert.match(css, /never overflow-x:\s*hidden on \.live-board/i);
  });
});

describe("TRA-98 board columns stay in one desktop row", () => {
  it("desktop board is a non-wrapping column track with a themed bottom scroller", () => {
    const desktop = declsFor(rules, ".board");
    hasDecl(desktop, "grid-auto-flow", "column");
    hasDecl(
      desktop,
      "grid-auto-columns",
      "minmax\\(\\s*200px\\s*,\\s*1fr\\s*\\)",
    );
    assert.doesNotMatch(desktop, /auto-fit/);

    const scroller = declsFor(rules, ".board-scroller");
    hasDecl(scroller, "overflow-x", "auto");
    hasDecl(scroller, "flex", "1");
    hasDecl(scroller, "scrollbar-color", "var\\(--border\\)\\s+var\\(--bg\\)");
    hasNoOverflowXHidden(scroller, ".board-scroller");
  });

  it("board page fills the project pane so the scrollbar sits at the bottom", () => {
    assert.match(css, /\.project-shell-main:has\(\s*\.live-board\s*\)/);
    assert.match(css, /body:has\(\s*\.project-shell\s*\)/);
  });

  it("mobile board stacks columns at the project-shell breakpoint", () => {
    const mobile = mobile640(rules);
    const board = declsFor(mobile, ".board");
    hasDecl(board, "grid-auto-flow", "row");
    hasDecl(board, "grid-template-columns", "1fr");
    const scroller = declsFor(mobile, ".board-scroller");
    hasDecl(scroller, "overflow-x", "visible");
    hasNoOverflowXHidden(scroller, "mobile .board-scroller");
  });
});

describe("TRA-100 board scroller contains overflow on both axes", () => {
  it("shell and live-board cannot grow past the pane", () => {
    const hasOpen =
      /\.site-main:has\(\s*>\s*\.project-shell\s*\)[^{]*\{/.exec(rules);
    assert.ok(hasOpen, "missing .site-main:has(> .project-shell)");
    const siteMain = braceBody(rules, hasOpen.index + hasOpen[0].length);
    hasDecl(siteMain, "min-width", "0");

    const liveBoard = declsFor(rules, ".live-board");
    hasDecl(liveBoard, "min-width", "0");
    hasDecl(liveBoard, "min-height", "0");
    hasDecl(liveBoard, "overflow", "hidden");
    hasNoOverflowXHidden(liveBoard, ".live-board");
  });

  it("desktop board fills the pane without intrinsic max-content tracks", () => {
    const desktop = declsFor(rules, ".board");
    hasDecl(desktop, "min-width", "100%");
    assert.doesNotMatch(desktop, /max-content/);
    const column = declsFor(rules, ".column");
    hasDecl(column, "min-width", "0");
  });

  it("mobile undoes containment so stacked columns are not clipped", () => {
    const mobile = mobile640(rules);
    const liveBoard = declsFor(mobile, ".live-board");
    hasDecl(liveBoard, "overflow", "visible");
    hasNoOverflowXHidden(liveBoard, "mobile .live-board");
    const board = declsFor(mobile, ".board");
    hasDecl(board, "width", "auto");
    hasDecl(board, "min-width", "0");
  });
});
