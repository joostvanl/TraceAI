import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));

describe("TRA-114 Agent APIs header", () => {
  it("AuthStatus has a link labelled exactly Agent APIs to /account/agent-apis", () => {
    const source = readFileSync(
      join(srcDir, "components", "AuthStatus.tsx"),
      "utf8",
    );
    assert.match(source, /href="\/account\/agent-apis"/);
    assert.match(source, />\s*Agent APIs\s*</);
    assert.match(source, /if \(!identity\) return null/);
  });

  it("does not put Agent APIs in ProjectSidebar", () => {
    const sidebar = readFileSync(
      join(srcDir, "components", "ProjectSidebar.tsx"),
      "utf8",
    );
    assert.doesNotMatch(sidebar, /Agent APIs/);
    assert.doesNotMatch(sidebar, /\/account\/agent-apis/);
  });

  it("account page chrome matches tokens (eyebrow Account, h1 Agent APIs)", () => {
    const page = readFileSync(
      join(srcDir, "app", "account", "agent-apis", "page.tsx"),
      "utf8",
    );
    assert.match(page, /className="account-page"/);
    assert.match(page, /className="eyebrow"/);
    assert.match(page, />Account</);
    assert.match(page, />Agent APIs</);
    assert.match(page, /identity\.mode !== "personal"/);
  });
});
