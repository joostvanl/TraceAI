import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

describe("TRA-97 ticket list column sort", () => {
  it("list headers are sort links with aria-sort and hidden sort fields", () => {
    const page = readFileSync(
      join(here, "../app/projects/[slug]/tickets/page.tsx"),
      "utf8",
    );
    assert.match(page, /ticketListColumnHref/);
    assert.match(page, /columnAriaSort/);
    assert.match(page, /aria-sort=/);
    assert.match(page, /name="sort"/);
    assert.match(page, /name="dir"/);
    assert.doesNotMatch(page, /'use client'/);
  });

  it("sort caret is CSS-only on the active column", () => {
    const css = readFileSync(join(here, "../app/globals.css"), "utf8");
    assert.match(css, /th\[aria-sort="ascending"\] a::after/);
    assert.match(css, /th\[aria-sort="descending"\] a::after/);
  });
});
