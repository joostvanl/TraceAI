import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const settings = readFileSync(
  join(here, "../app/projects/[slug]/settings/page.tsx"),
  "utf8",
);
const panel = readFileSync(
  join(here, "../components/WorkflowEditorPanel.tsx"),
  "utf8",
);
const toolbar = readFileSync(
  join(here, "../components/WorkflowEditorToolbar.tsx"),
  "utf8",
);
const draft = readFileSync(
  join(here, "../app/api/projects/[slug]/workflow/draft/route.ts"),
  "utf8",
);

describe("TRA-88 settings editor guards", () => {
  it("E1: settings unwraps workflow searchParams", () => {
    assert.match(settings, /searchParams: Promise<\{ tab\?: string; workflow\?: string \}>/);
    assert.match(settings, /editorWorkflowSlugForRequest/);
    assert.match(settings, /WorkflowEditorToolbar/);
  });

  it("E4: editor writes pass the selected workflow slug", () => {
    assert.match(panel, /workflow\/draft\?workflow=\$\{encodeURIComponent\(initial\.slug\)\}/);
    assert.match(
      panel,
      /workflow\/activate\?workflow=\$\{encodeURIComponent\(initial\.slug\)\}/,
    );
    assert.doesNotMatch(
      panel,
      /workflow\/draft`/,
    );
  });

  it("E5: draft proxy resolves ?workflow= and does not fall back when set", () => {
    assert.match(draft, /resolveEditorWorkflowSlug/);
    assert.doesNotMatch(draft, /fields\.default_workflow/);
  });

  it("K7: clone UI is platform-admin only", () => {
    assert.match(toolbar, /isPlatformAdmin && cloneSources/);
    assert.match(toolbar, /Clonen van ander project/);
  });

  it("C3: create navigates to the new slug and does not auto-default", () => {
    assert.match(toolbar, /router\.push\(editorHref\(body\.slug\)\)/);
    assert.doesNotMatch(toolbar, /default_workflow: body\.slug/);
  });
});
