import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const form = readFileSync(
  join(here, "../components/CreateTicketForm.tsx"),
  "utf8",
);
const route = readFileSync(
  join(here, "../app/api/tickets/route.ts"),
  "utf8",
);
const insights = readFileSync(join(here, "cms.ts"), "utf8");

describe("TRA-87 web create / insights guards", () => {
  it("U4: CreateTicketForm posts the selected workflow", () => {
    assert.match(form, /workflow,/);
    assert.match(form, /boardHref/);
  });

  it("U5: login next uses the visible board href", () => {
    assert.match(
      form,
      /login\?next=\$\{encodeURIComponent\(boardHref\)\}/,
    );
  });

  it("C1: web tickets route does not hardcode stage backlog", () => {
    assert.doesNotMatch(route, /stage:\s*"backlog"/);
    assert.match(route, /workflow/);
  });

  it("TRA-149 gates Cloud assignment fail-closed and forwards the boolean", () => {
    assert.match(form, />Assign aan Cloud agent</);
    assert.match(form, /useState\(false\)/);
    assert.match(form, /cursor_cloud_available === true/);
    assert.match(form, /\.catch\(\(\) => false\)/);
    assert.match(form, /cursorCloudAvailable \? \(/);
    assert.match(form, /assign_cloud_agent: assignCloudAgent/);
    assert.match(route, /typeof body\.assign_cloud_agent !== "boolean"/);
    assert.match(route, /assign_cloud_agent: assignCloudAgent/);
  });

  it("G8: insights still loads the default board for the Done-key", () => {
    const fn = insights.slice(insights.indexOf("export async function getProjectInsightsPublic"));
    assert.match(fn, /getProjectBoard\(projectSlug\)/);
    assert.doesNotMatch(
      fn.slice(0, 400),
      /getProjectBoard\(projectSlug,\s*/,
    );
  });
});
