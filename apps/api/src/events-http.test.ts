import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, DEFAULT_AGENT_SCOPES } from "@traceai/auth";
import { createApp } from "./app.js";
import {
  configureEventBus,
  publishTicketEvent,
  ticketEventFromMapped,
} from "./events.js";
import { projectMemberStubs } from "./test-support.js";

const OWN = "traceai";
const FOREIGN = "secret-project";
const MEMBER_EMAIL = "ui+joostvl@users.traceai.local";

type SseEvent = { event: string; id?: string; data: string };

function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: SseEvent[] = [];
  for (const part of parts) {
    let event = "message";
    let id: string | undefined;
    let data = "";
    for (const line of part.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("id:")) id = line.slice(3).trim();
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    events.push({ event, id, data });
  }
  return { events, rest };
}

async function readSseUntil(
  res: Response,
  pred: (events: SseEvent[]) => boolean,
  ms = 2500,
): Promise<SseEvent[]> {
  assert.ok(res.body, "SSE response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: SseEvent[] = [];
  const timer = setTimeout(() => {
    void reader.cancel();
  }, ms);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSse(buffer);
      buffer = parsed.rest;
      events.push(...parsed.events);
      if (pred(events)) break;
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
  return events;
}

function memberService(projects: string[] = [OWN]) {
  return {
    ...projectMemberStubs({
      email: MEMBER_EMAIL,
      projects,
      userSlug: "joostvl",
    }),
    getTraceaiUser: async (slug: string) =>
      slug === "joostvl"
        ? {
            slug: "joostvl",
            fields: {
              username: "joostvl",
              email: MEMBER_EMAIL,
              status: "active",
              is_platform_admin: false,
            },
          }
        : null,
  };
}

async function withApp(
  scopes: string[],
  email: string,
  service: unknown,
  fn: (app: ReturnType<typeof createApp>, token: string) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "traceai-events-http-"));
  const store = new AuthStore(join(dir, "auth.sqlite"));
  try {
    const user = store.createUser({ email, name: "Tester" });
    const token = store.createToken({
      userId: user.id,
      name: "agent",
      scopes: scopes as never,
    });
    const app = createApp({ authStore: store, service: service as never });
    await fn(app, token.token);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function authHeaders(token: string, extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "text/event-stream",
    ...extra,
  };
}

describe("GET /events authorization (TRA-84)", () => {
  beforeEach(() => {
    configureEventBus({ dbPath: ":memory:" });
  });

  afterEach(() => {
    configureEventBus({ dbPath: ":memory:" });
  });

  it("A1: no Authorization is 401 and leaks no ticket JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-events-http-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    try {
      const app = createApp({
        authStore: store,
        service: memberService() as never,
      });
      const res = await app.request("/events");
      assert.equal(res.status, 401);
      const raw = await res.text();
      assert.ok(!raw.includes("ticket."), raw);
      assert.ok(!raw.includes('"title"'), raw);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A2: no token + project + Last-Event-ID is still 401", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceai-events-http-"));
    const store = new AuthStore(join(dir, "auth.sqlite"));
    try {
      const app = createApp({
        authStore: store,
        service: memberService() as never,
      });
      const res = await app.request(`/events?project=${OWN}&after=1`, {
        headers: { "Last-Event-ID": "1" },
      });
      assert.equal(res.status, 401);
      const raw = await res.text();
      assert.ok(!raw.includes('"title"'), raw);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A3: member without project is 400 VALIDATION", async () => {
    await withApp(
      [...DEFAULT_AGENT_SCOPES],
      MEMBER_EMAIL,
      memberService(),
      async (app, token) => {
        const res = await app.request("/events", {
          headers: authHeaders(token),
        });
        assert.equal(res.status, 400);
        const body = (await res.json()) as { code?: string };
        assert.equal(body.code, "VALIDATION");
      },
    );
  });

  it("A4: member on a foreign project is 404 without ticket JSON", async () => {
    await withApp(
      [...DEFAULT_AGENT_SCOPES],
      MEMBER_EMAIL,
      memberService([OWN]),
      async (app, token) => {
        const res = await app.request(`/events?project=${FOREIGN}`, {
          headers: authHeaders(token),
        });
        assert.equal(res.status, 404);
        const raw = await res.text();
        assert.ok(!raw.includes("Secret ticket"), raw);
        assert.ok(!raw.includes('"title"'), raw);
      },
    );
  });

  it("A5: member live stream only includes their project", async () => {
    await withApp(
      [...DEFAULT_AGENT_SCOPES],
      MEMBER_EMAIL,
      memberService([OWN]),
      async (app, token) => {
        const res = await app.request(`/events?project=${OWN}`, {
          headers: authHeaders(token),
        });
        assert.equal(res.status, 200);
        let published = false;
        const live = await readSseUntil(
          res,
          (events) => {
            if (!published && events.some((e) => e.event === "connected")) {
              published = true;
              publishTicketEvent(
                ticketEventFromMapped("ticket.created", {
                  slug: "own-card",
                  title: "Own card",
                  stage: "todo",
                  project: OWN,
                }),
              );
              publishTicketEvent(
                ticketEventFromMapped("ticket.created", {
                  slug: "foreign-card",
                  title: "Foreign secret",
                  stage: "todo",
                  project: FOREIGN,
                }),
              );
            }
            return events.some((e) => e.data.includes("own-card"));
          },
          3000,
        );
        const payloads = live.map((e) => e.data).join("\n");
        assert.match(payloads, /own-card/);
        assert.doesNotMatch(payloads, /Foreign secret/);
        assert.doesNotMatch(payloads, /foreign-card/);
      },
    );
  });

  it("A6: Last-Event-ID replay omits foreign-project rows", async () => {
    const own = publishTicketEvent(
      ticketEventFromMapped("ticket.created", {
        slug: "own-replay",
        title: "Own replay",
        stage: "todo",
        project: OWN,
      }),
    );
    publishTicketEvent(
      ticketEventFromMapped("ticket.created", {
        slug: "foreign-replay",
        title: "Foreign replay",
        stage: "todo",
        project: FOREIGN,
      }),
    );

    await withApp(
      [...DEFAULT_AGENT_SCOPES],
      MEMBER_EMAIL,
      memberService([OWN]),
      async (app, token) => {
        const res = await app.request(`/events?project=${OWN}`, {
          headers: authHeaders(token, {
            "Last-Event-ID": String(own.event_id - 1),
          }),
        });
        assert.equal(res.status, 200);
        const events = await readSseUntil(
          res,
          (seen) => seen.some((e) => e.data.includes("own-replay")),
          3000,
        );
        const payloads = events.map((e) => e.data).join("\n");
        assert.match(payloads, /own-replay/);
        assert.doesNotMatch(payloads, /Foreign replay/);
        assert.doesNotMatch(payloads, /foreign-replay/);
      },
    );
  });

  it("A7: admin-scope token without project sees every project", async () => {
    publishTicketEvent(
      ticketEventFromMapped("ticket.created", {
        slug: "admin-own",
        title: "Admin own",
        stage: "todo",
        project: OWN,
      }),
    );
    publishTicketEvent(
      ticketEventFromMapped("ticket.created", {
        slug: "admin-foreign",
        title: "Admin foreign",
        stage: "todo",
        project: FOREIGN,
      }),
    );

    await withApp(["admin"], "ops@example.com", memberService([]), async (app, token) => {
      const res = await app.request("/events?after=0", {
        headers: authHeaders(token),
      });
      assert.equal(res.status, 200);
      const events = await readSseUntil(
        res,
        (seen) =>
          seen.some((e) => e.data.includes("admin-own")) &&
          seen.some((e) => e.data.includes("admin-foreign")),
        3000,
      );
      const payloads = events.map((e) => e.data).join("\n");
      assert.match(payloads, /admin-own/);
      assert.match(payloads, /admin-foreign/);
    });
  });

  it("A8: admin-scope token with project is filtered", async () => {
    publishTicketEvent(
      ticketEventFromMapped("ticket.created", {
        slug: "filtered-own",
        title: "Filtered own",
        stage: "todo",
        project: OWN,
      }),
    );
    publishTicketEvent(
      ticketEventFromMapped("ticket.created", {
        slug: "filtered-foreign",
        title: "Filtered foreign",
        stage: "todo",
        project: FOREIGN,
      }),
    );

    await withApp(["admin"], "ops@example.com", memberService([]), async (app, token) => {
      const res = await app.request(`/events?project=${OWN}&after=0`, {
        headers: authHeaders(token),
      });
      assert.equal(res.status, 200);
      const events = await readSseUntil(
        res,
        (seen) => seen.some((e) => e.data.includes("filtered-own")),
        3000,
      );
      const payloads = events.map((e) => e.data).join("\n");
      assert.match(payloads, /filtered-own/);
      assert.doesNotMatch(payloads, /Filtered foreign/);
    });
  });
});
