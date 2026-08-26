import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));

describe("TRA-111 header API-tokens removal", () => {
  it("AuthStatus has no API-tokens /account/tokens link", () => {
    const authStatus = readFileSync(
      join(srcDir, "components", "AuthStatus.tsx"),
      "utf8",
    );
    assert.doesNotMatch(authStatus, /\/account\/tokens/);
    assert.doesNotMatch(authStatus, /API-tokens/);
    assert.doesNotMatch(authStatus, /auth-account-link/);
    assert.match(authStatus, /href="\/inbox"/);
    assert.match(authStatus, /href="\/admin\/users"/);
  });

  it("ProjectSidebar still has the API-tokens left-menu item", () => {
    const sidebar = readFileSync(
      join(srcDir, "components", "ProjectSidebar.tsx"),
      "utf8",
    );
    assert.match(sidebar, /label: "API-tokens"/);
    assert.match(sidebar, /\/projects\/\$\{slug\}\/tokens/);
  });

  it("token pages remain reachable by URL", () => {
    assert.ok(
      existsSync(join(srcDir, "app", "account", "tokens", "page.tsx")),
      "account tokens page missing",
    );
    assert.ok(
      existsSync(join(srcDir, "app", "projects", "[slug]", "tokens", "page.tsx")),
      "project tokens page missing",
    );
  });

  it("homepage connect fallback no longer points at the header", () => {
    const cms = readFileSync(join(srcDir, "lib", "cms.ts"), "utf8");
    assert.doesNotMatch(cms, /Open API-tokens in the header/);
    assert.doesNotMatch(cms, /API-tokens \(header link\)/);
    assert.match(cms, /API-tokens in the left menu/);
    assert.match(cms, /API-tokens in the project left menu/);
  });

  it("unused .auth-account-link CSS is gone", () => {
    const css = readFileSync(join(srcDir, "app", "globals.css"), "utf8");
    assert.doesNotMatch(css, /\.auth-account-link/);
  });
});
