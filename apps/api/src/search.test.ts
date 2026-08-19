import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AuthStore, DEFAULT_AGENT_SCOPES } from "@traceai/auth";
import { createApp } from "./app.js";
import { projectMemberStubs } from "./test-support.js";

describe("GET /v1/projects/:slug/search", () => {
  it("forwards retrieval profile and preview controls", async () => {
    const directory = mkdtempSync(join(tmpdir(), "traceai-search-"));
    const store = new AuthStore(join(directory, "auth.sqlite"));
    try {
      const user = store.createUser({ email: "s@example.com", name: "Search" });
      const token = store.createToken({
        userId: user.id,
        name: "agent",
        scopes: [...DEFAULT_AGENT_SCOPES],
      });
      let seen: Record<string, unknown> | undefined;
      const app = createApp({
        authStore: store,
        service: {
          ...projectMemberStubs({
            email: "s@example.com",
            projects: ["traceai"],
          }),
          searchProject: async (input: Record<string, unknown>) => {
            seen = input;
            return {
              items: [],
              total: 0,
              limit: 8,
              offset: 0,
              meta: {
                algorithm: "bm25",
                profile: "focused",
                query_tokens: ["search"],
                prefix_expansions_truncated: false,
                indexed_documents: 10,
              },
            };
          },
        } as never,
      });

      const response = await app.request(
        "/v1/projects/traceai/search?q=search&profile=focused&include_preview=false",
        { headers: { Authorization: `Bearer ${token.token}` } },
      );
      assert.equal(response.status, 200);
      assert.equal(seen?.project, "traceai");
      assert.equal(seen?.profile, "focused");
      assert.equal(seen?.includePreview, false);
      assert.equal(seen?.limit, undefined);
      const body = (await response.json()) as {
        meta: { algorithm: string };
      };
      assert.equal(body.meta.algorithm, "bm25");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
