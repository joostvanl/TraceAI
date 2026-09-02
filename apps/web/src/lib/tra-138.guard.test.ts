import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const board = readFileSync(join(here, "../components/LiveBoard.tsx"), "utf8");
const css = readFileSync(join(here, "../app/globals.css"), "utf8");

function ruleBodies(source: string, selector: string): string[] {
  const bodies: string[] = [];
  const re = new RegExp(
    `(?:^|[\\s,{])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`,
    "g",
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const start = source.indexOf("{", match.index);
    if (start < 0) continue;
    let depth = 0;
    for (let i = start; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) {
          bodies.push(source.slice(start + 1, i));
          break;
        }
      }
    }
  }
  return bodies;
}

describe("TRA-138 active-work blink on board cards", () => {
  it("LiveBoard applies ticket-active via isActiveWorkStage", () => {
    assert.match(board, /import \{ isActiveWorkStage \} from "@\/lib\/active-work-stage"/);
    assert.match(board, /isActiveWorkStage\(\{/);
    assert.match(board, /stage\.requiresHumanApproval === true/);
    assert.match(board, /ticket-active/);
    assert.doesNotMatch(board, /in_progress.*ticket-active|ticket-active.*in_progress/);
  });

  it("CSS blinks only border-color and respects reduced motion", () => {
    assert.match(css, /@keyframes ticket-active-border/);
    assert.match(
      css,
      /\.ticket-card\.ticket-active\s*\{[\s\S]*?animation:\s*ticket-active-border/,
    );
    assert.match(css, /prefers-reduced-motion:\s*reduce/);
    const reduced = css.slice(css.search(/prefers-reduced-motion:\s*reduce/));
    assert.match(
      reduced,
      /\.ticket-card\.ticket-active[\s\S]*?animation:\s*none[\s\S]*?border-color:\s*var\(--accent\)/,
    );

    const keyframes = css.match(
      /@keyframes ticket-active-border\s*\{([\s\S]*?)\n\}/,
    );
    assert.ok(keyframes);
    assert.match(keyframes[1]!, /border-color:\s*var\(--border\)/);
    assert.match(keyframes[1]!, /border-color:\s*var\(--accent\)/);
    assert.doesNotMatch(keyframes[1]!, /box-shadow/);
    assert.doesNotMatch(keyframes[1]!, /outline/);

    const activeBodies = ruleBodies(css, ".ticket-card.ticket-active");
    assert.ok(activeBodies.length >= 1);
    for (const body of activeBodies) {
      assert.doesNotMatch(body, /box-shadow/);
    }

    assert.match(css, /\.ticket-card\.ticket-active:hover/);
    assert.doesNotMatch(
      css,
      /\.ticket-card\.ticket-active:hover\s*\{[^}]*border-color:/,
    );
  });

  it("does not add overflow-x: hidden on .live-board or .board-scroller", () => {
    for (const selector of [".live-board", ".board-scroller"]) {
      for (const body of ruleBodies(css, selector)) {
        assert.doesNotMatch(body, /overflow-x:\s*hidden/);
      }
    }
  });
});
