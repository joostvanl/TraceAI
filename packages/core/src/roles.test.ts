import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isProjectRole,
  membershipSlug,
  requiredRoleForAction,
  roleAtLeast,
} from "./roles.js";

describe("roles", () => {
  it("accepts known project roles", () => {
    assert.equal(isProjectRole("admin"), true);
    assert.equal(isProjectRole("editor"), true);
    assert.equal(isProjectRole("viewer"), true);
    assert.equal(isProjectRole("owner"), false);
  });

  it("compares role ranks", () => {
    assert.equal(roleAtLeast("admin", "viewer"), true);
    assert.equal(roleAtLeast("editor", "admin"), false);
    assert.equal(roleAtLeast(null, "viewer"), false);
  });

  it("maps actions to required roles", () => {
    assert.equal(requiredRoleForAction("read"), "viewer");
    assert.equal(requiredRoleForAction("write_tickets"), "editor");
    assert.equal(requiredRoleForAction("manage_members"), "admin");
  });

  it("builds membership slugs", () => {
    assert.equal(membershipSlug("traceai", "joost"), "traceai--joost");
  });
});
