import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, DEFAULT_AGENT_SCOPES } from "@traceai/auth";
import {
  ExpectedStateRequiredError,
  HumanGateOpenError,
  MISSING_EXPECTED_STAGE,
  StageConflictError,
  ValidationError,
} from "@traceai/core";
import { createApp } from "./app.js";
import { projectMemberStubs } from "./test-support.js";

const COMMENT =
  "## Vorige stap\nWas in todo.\n\n## Deze stap\nMoving to in progress.";

function fakeTicket(stage = "todo") {
  return {
    id: "id-t",
    slug: "demo-ticket",
    fields: {
      title: "Demo",
      description: "",
      project: "traceai",
      workflow: "standard-worker",
      stage,
      ticket_key: "TRA-1",
      ticket_number: 1,
      tokens_estimate: null,
      tokens_actual: null,
      resolution: null,
    },
  };
}

async function withApp(
  service: Record<string, unknown>,
  fn: (app: ReturnType<typeof createApp>, token: string) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "traceai-stage-conflict-"));
  const store = new AuthStore(join(dir, "auth.sqlite"));
  try {
    const user = store.createUser({ email: "e@example.com", name: "E" });
    const token = store.createToken({
      userId: user.id,
      name: "agent",
      scopes: [...DEFAULT_AGENT_SCOPES],
    });
    const app = createApp({
      authStore: store,
      service: {
        ...projectMemberStubs({ email: "e@example.com", projects: ["traceai"] }),
        getTicket: async () => ({ ticket: fakeTicket() }),
        getProject: async () => null,
        ...service,
      } as never,
    });
    await fn(app, token.token);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function post(
  app: ReturnType<typeof createApp>,
  token: string,
  body: unknown,
) {
  return app.request("/v1/tickets/demo-ticket/transition", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/tickets/:slug/transition stale-state (TRA-73)", () => {
  it("A1: StageConflictError → HTTP 409 with structured fields", async () => {
    await withApp(
      {
        transitionTicket: async () => {
          throw new StageConflictError(
            "todo",
            "review",
            null,
            null,
            "in_progress",
            "2026-08-17T19:33:51.374Z",
            [
              {
                author: "Joost",
                createdAt: "2026-08-17T19:33:51.374Z",
                body: "moved",
                truncated: false,
              },
            ],
            'Ticket is in "review", not the expected "todo". Another actor moved it.',
          );
        },
      },
      async (app, token) => {
        const res = await post(app, token, {
          to_stage: "in_progress",
          comment: COMMENT,
          expected_stage: "todo",
        });
        assert.equal(res.status, 409);
        const body = (await res.json()) as {
          code?: string;
          current_stage?: string;
          review_state?: string | null;
          recent_comments?: unknown[];
        };
        assert.equal(body.code, "STAGE_CONFLICT");
        assert.equal(body.current_stage, "review");
        assert.equal(body.review_state, null);
        assert.equal(body.recent_comments?.length, 1);
      },
    );
  });

  it("A1b: HumanGateOpenError → HTTP 409 HUMAN_GATE_OPEN", async () => {
    await withApp(
      {
        transitionTicket: async () => {
          throw new HumanGateOpenError(
            "todo",
            null,
            "in_progress",
            ["in_progress", "done"],
            'Stage "todo" is waiting for a human review verdict.',
          );
        },
      },
      async (app, token) => {
        const res = await post(app, token, {
          to_stage: "in_progress",
          comment: COMMENT,
          expected_stage: "todo",
          expected_review_state: null,
        });
        assert.equal(res.status, 409);
        const body = (await res.json()) as {
          code?: string;
          current_stage?: string;
          review_state?: string | null;
          allowed_targets?: string[];
        };
        assert.equal(body.code, "HUMAN_GATE_OPEN");
        assert.equal(body.current_stage, "todo");
        assert.equal(body.review_state, null);
        assert.deepEqual(body.allowed_targets, ["in_progress", "done"]);
      },
    );
  });

  it("A2: without expected_* and service succeeds → 200", async () => {
    await withApp(
      {
        transitionTicket: async () => fakeTicket("in_progress"),
      },
      async (app, token) => {
        const res = await post(app, token, {
          to_stage: "in_progress",
          comment: COMMENT,
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { stage?: string; slug?: string };
        assert.equal(body.slug, "demo-ticket");
        assert.equal(body.stage, "in_progress");
      },
    );
  });

  it("A3: expected_review_state null is forwarded, not dropped", async () => {
    let seen: { expected_review_state?: unknown; reviewStateProvided?: boolean } =
      {};
    await withApp(
      {
        transitionTicket: async (
          _slug: string,
          _to: string,
          options: {
            expected_review_state?: string | null;
            reviewStateProvided?: boolean;
          },
        ) => {
          seen = options;
          return fakeTicket("in_progress");
        },
      },
      async (app, token) => {
        const res = await post(app, token, {
          to_stage: "in_progress",
          comment: COMMENT,
          expected_stage: "todo",
          expected_review_state: null,
        });
        assert.equal(res.status, 200);
      },
    );
    assert.equal(seen.expected_review_state, null);
    assert.equal(seen.reviewStateProvided, true);
  });

  it("A4: missing to_stage → 400 VALIDATION, not 409", async () => {
    await withApp(
      {
        transitionTicket: async () => {
          throw new Error("service must not be called");
        },
      },
      async (app, token) => {
        const res = await post(app, token, { comment: COMMENT });
        assert.equal(res.status, 400);
        const body = (await res.json()) as { code?: string };
        assert.equal(body.code, "VALIDATION");
      },
    );
  });

  it("A5: invalid transition ValidationError is 400, not 409 or 403", async () => {
    await withApp(
      {
        transitionTicket: async () => {
          throw new ValidationError(
            'Transition from "todo" to "done" is not allowed',
          );
        },
      },
      async (app, token) => {
        const res = await post(app, token, {
          to_stage: "done",
          comment: COMMENT,
        });
        assert.equal(res.status, 400);
        const body = (await res.json()) as { code?: string };
        assert.equal(body.code, "VALIDATION");
        assert.notEqual(res.status, 409);
        assert.notEqual(res.status, 403);
      },
    );
  });

  it("A6: ExpectedStateRequiredError → HTTP 400 VALIDATION, not 403", async () => {
    await withApp(
      {
        transitionTicket: async () => {
          throw new ExpectedStateRequiredError(MISSING_EXPECTED_STAGE);
        },
      },
      async (app, token) => {
        const res = await post(app, token, {
          to_stage: "in_progress",
          comment: COMMENT,
        });
        assert.equal(res.status, 400, "must not become 403 via onError");
        const body = (await res.json()) as { code?: string; message?: string };
        assert.equal(body.code, "VALIDATION");
        assert.equal(body.message, MISSING_EXPECTED_STAGE);
      },
    );
  });
});
