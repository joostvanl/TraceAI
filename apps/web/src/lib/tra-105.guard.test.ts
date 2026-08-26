import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const component = readFileSync(
  join(here, "../components/HumanReviewActions.tsx"),
  "utf8",
);
const css = readFileSync(join(here, "../app/globals.css"), "utf8");
const reviewRoute = readFileSync(
  join(here, "../app/api/tickets/[slug]/review/route.ts"),
  "utf8",
);
const inbox = readFileSync(join(here, "../app/inbox/page.tsx"), "utf8");
const ticketDetail = readFileSync(
  join(here, "../app/projects/[slug]/tickets/[ticketSlug]/page.tsx"),
  "utf8",
);

describe("TRA-105 one-step human-gate panel", () => {
  it("waiting panel is one form: comment field then configured outcome buttons", () => {
    assert.match(component, /Toelichting \(optioneel bij Goedkeuren/);
    assert.match(component, /requiredHint/);
    assert.match(component, /chooseVerdict\("approved"\)/);
    assert.match(component, /chooseVerdict\("rejected"\)/);
    assert.match(component, /chooseVerdict\("dismissed"\)/);
    assert.match(component, />\s*Goedkeuren\s*</);
    assert.match(component, />\s*Afkeuren\s*</);
    assert.match(component, />\s*Annuleren\s*</);
    assert.doesNotMatch(component, /type Mode =/);
    assert.doesNotMatch(component, /setMode\(/);
    assert.doesNotMatch(component, /Bevestig goedkeuring/);
    assert.doesNotMatch(component, /Bevestig afkeuring/);
    assert.doesNotMatch(component, /Bevestig afzien/);
    assert.doesNotMatch(component, /Afzien/);
  });

  it("does not hint at target stages on the waiting panel", () => {
    assert.doesNotMatch(component, /goedkeuren →/);
    assert.doesNotMatch(component, /afkeuren →/);
    assert.doesNotMatch(component, /afzien →/);
    assert.doesNotMatch(component, /outcomeHints/);
    assert.doesNotMatch(component, /De agent brengt dit ticket naar/);
  });

  it("unifies note/reason into one comment and keeps the review POST payload", () => {
    assert.match(component, /const \[comment, setComment\]/);
    assert.doesNotMatch(component, /const \[note, setNote\]/);
    assert.doesNotMatch(component, /const \[reason, setReason\]/);
    assert.match(component, /verdict: action/);
    assert.match(component, /comment: comment\.trim\(\)/);
    assert.match(component, /apply_to_children: applyToChildren/);
    assert.match(reviewRoute, /const comment = body\.comment\?\.trim\(\) \?\? ""/);
    assert.match(reviewRoute, /verdict !== "approved" && !comment/);
  });

  it("blocks empty Afkeuren/Annuleren client-side and allows empty Goedkeuren", () => {
    assert.match(
      component,
      /commentRequiredForVerdict\(action\) && !comment\.trim\(\)/,
    );
    assert.match(component, /Dit oordeel heeft een toelichting nodig/);
    assert.match(component, /className="form-error"/);
    assert.match(
      component,
      /function commentRequiredForVerdict\(action: VerdictAction\): boolean \{[\s\S]*return action !== "approved";/,
    );
  });

  it("keeps recorded verdict, Oordeel wijzigen, guest prompt, and cascade confirm", () => {
    assert.match(component, /Beoordeling vastgelegd/);
    assert.match(component, /Oordeel wijzigen/);
    assert.match(component, /Menselijke beoordeling vereist/);
    assert.match(component, /Ook children beoordelen\?/);
    assert.match(component, /Ja, ook alle children/);
    assert.match(component, /state === "dismissed"\) return "Geannuleerd"/);
    assert.match(inbox, /HumanReviewActions/);
    assert.match(ticketDetail, /HumanReviewActions/);
  });

  it("hides unconfigured outcomes", () => {
    assert.match(component, /const showApprove = Boolean\(gate\.approveTo\)/);
    assert.match(component, /const showReject = Boolean\(gate\.rejectTo\)/);
    assert.match(component, /const showDismiss = Boolean\(gate\.dismissTo\)/);
    assert.match(component, /\{showApprove \? \(/);
    assert.match(component, /\{showReject \? \(/);
    assert.match(component, /\{showDismiss \? \(/);
  });

  it("CSS is one form layout without unused wizard classes", () => {
    assert.match(css, /\.human-review-form \{[\s\S]*display:\s*grid/);
    assert.match(css, /\.human-review-actions \{[\s\S]*flex-wrap:\s*wrap/);
    assert.match(css, /\.human-review-form textarea,[\s\S]*min-width:\s*0/);
    assert.doesNotMatch(css, /human-review-form-title/);
    assert.doesNotMatch(css, /\.human-review-form\.reject/);
  });
});
