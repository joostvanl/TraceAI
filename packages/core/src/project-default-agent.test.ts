import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  projectDefaultFieldState,
  uniqueMembershipBcDefault,
} from "./project-default-agent.js";

describe("uniqueMembershipBcDefault", () => {
  it("returns the single distinct bc- value", () => {
    assert.equal(
      uniqueMembershipBcDefault(["bc-one", "", "bc-one", null]),
      "bc-one",
    );
  });

  it("ignores non-bc membership values", () => {
    assert.equal(uniqueMembershipBcDefault(["local-agent", "bc-only"]), "bc-only");
  });

  it("returns null when zero or two+ distinct bc- values", () => {
    assert.equal(uniqueMembershipBcDefault([]), null);
    assert.equal(uniqueMembershipBcDefault(["", "local-agent"]), null);
    assert.equal(uniqueMembershipBcDefault(["bc-a", "bc-b"]), null);
  });
});

describe("projectDefaultFieldState", () => {
  it("treats missing/null as not written", () => {
    assert.deepEqual(projectDefaultFieldState(undefined), {
      written: false,
      value: null,
    });
    assert.deepEqual(projectDefaultFieldState(null), {
      written: false,
      value: null,
    });
  });

  it("treats empty string as written (cleared / initialized)", () => {
    assert.deepEqual(projectDefaultFieldState(""), {
      written: true,
      value: null,
    });
    assert.deepEqual(projectDefaultFieldState("   "), {
      written: true,
      value: null,
    });
  });

  it("returns a stored id", () => {
    assert.deepEqual(projectDefaultFieldState("bc-keep"), {
      written: true,
      value: "bc-keep",
    });
  });
});
