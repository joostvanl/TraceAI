import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

describe("TRA-114 live nudge does not use CURSOR_API_KEY", () => {
  it("createApp no longer constructs CursorCloudAgentClient.fromEnv", () => {
    const source = readFileSync(join(here, "app.ts"), "utf8");
    assert.doesNotMatch(source, /CursorCloudAgentClient\.fromEnv\(/);
    assert.match(source, /cursorFollowUpForClaimer/);
  });
});
