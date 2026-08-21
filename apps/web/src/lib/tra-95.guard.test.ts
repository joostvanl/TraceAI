import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

describe("TRA-95 ticket workflow select", () => {
  it("T10: ticket detail uses TicketWorkflowSelect gated by canChange", () => {
    const page = readFileSync(
      join(here, "../app/projects/[slug]/tickets/[ticketSlug]/page.tsx"),
      "utf8",
    );
    assert.match(page, /TicketWorkflowSelect/);
    assert.match(page, /canChangeWorkflow/);
    assert.match(page, /isTicketWorkflowReassignable/);
    assert.doesNotMatch(
      page,
      /<span className="badge">\s*\{workflow\?\.fields\.name/,
    );
  });

  it("select posts PATCH /api/tickets/:slug with workflow", () => {
    const select = readFileSync(
      join(here, "../components/TicketWorkflowSelect.tsx"),
      "utf8",
    );
    assert.match(select, /method: "PATCH"/);
    assert.match(select, /JSON\.stringify\(\{ workflow: next \}\)/);
    assert.match(select, /window\.confirm/);
  });
});
