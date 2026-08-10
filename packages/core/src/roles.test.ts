import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isProjectRole,
  membershipSlug,
  requiredRoleForAction,
  roleAtLeast,
  wouldRemoveLastPlatformAdmin,
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

  it("builds URL-safe membership slugs", () => {
    assert.equal(membershipSlug("traceai", "joost"), "traceai-member-joost");
    assert.doesNotMatch(membershipSlug("traceai", "joost"), /--/);
  });

  it("blocks removing the last active platform admin", () => {
    const users = [
      { slug: "a", status: "active", is_platform_admin: true },
      { slug: "b", status: "active", is_platform_admin: false },
    ];
    assert.equal(
      wouldRemoveLastPlatformAdmin(users, "a", { status: "disabled" }),
      true,
    );
    assert.equal(
      wouldRemoveLastPlatformAdmin(users, "a", { is_platform_admin: false }),
      true,
    );
    assert.equal(
      wouldRemoveLastPlatformAdmin(users, "b", { status: "disabled" }),
      false,
    );

    const twoAdmins = [
      ...users,
      { slug: "c", status: "active", is_platform_admin: true },
    ];
    assert.equal(
      wouldRemoveLastPlatformAdmin(twoAdmins, "a", { status: "disabled" }),
      false,
    );
  });
});
