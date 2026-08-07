/**
 * E2E checks for the login-gated New ticket flow against the public TraceAI stack.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const mcp = JSON.parse(
  readFileSync(join(homedir(), ".cursor", "mcp.json"), "utf8").replace(/^\uFEFF/, ""),
);
const token = mcp.mcpServers.traceai.env.TRACEAI_TOKEN;
const login = JSON.parse(readFileSync(join("scripts", ".ui-login.local"), "utf8"));
const web = "https://traceai.joostvanleeuwaarden.com";
const api = "https://traceai.joostvanleeuwaarden.com";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function apiJson(path, init = {}) {
  const res = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { res, body };
}

async function postTicket(payload, cookie) {
  return fetch(`${web}/api/tickets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(payload),
  });
}

const boardHtml = await (await fetch(`${web}/projects/traceai`)).text();
assert(
  boardHtml.includes("Sign in") || boardHtml.includes("New ticket"),
  "board missing create/sign-in UI",
);
assert(
  !boardHtml.includes("Create secret"),
  "board still renders the create-secret field",
);
console.log("PASS board renders without a create-secret field");

const anonymous = await postTicket({
  project: "traceai",
  title: "should fail",
  description: "short wish",
});
assert(anonymous.status === 401, `expected 401 without session, got ${anonymous.status}`);
console.log("PASS no session → 401");

const badLogin = await fetch(`${web}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: login.user, password: "definitely-wrong" }),
});
assert(badLogin.status === 401, `expected 401 for bad password, got ${badLogin.status}`);
console.log("PASS wrong password → 401");

const goodLogin = await fetch(`${web}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: login.user, password: login.password }),
});
assert(goodLogin.ok, `login failed: ${goodLogin.status}`);
const setCookie = goodLogin.headers.get("set-cookie") ?? "";
assert(/HttpOnly/i.test(setCookie), `session cookie is not HttpOnly: ${setCookie}`);
const cookie = setCookie.split(";")[0];
assert(cookie.startsWith("traceai_session="), `unexpected cookie: ${cookie}`);
console.log("PASS login sets an HttpOnly session cookie");

const title = `Wish E2E ${new Date().toISOString().slice(11, 19)}`;
const createdRes = await postTicket(
  {
    project: "traceai",
    title,
    description: "Ik wil een lichte wens vastleggen zonder playbook-secties.",
    priority: "low",
  },
  cookie,
);
const createdBody = await createdRes.json();
assert(
  createdRes.status === 201,
  `create failed: ${createdRes.status} ${JSON.stringify(createdBody)}`,
);
assert(createdBody.stage === "backlog", `expected backlog, got ${createdBody.stage}`);
console.log("PASS light create → backlog", createdBody.ticket_key ?? createdBody.slug);

const comment = `## Vorige stap
Wish captured in backlog without refinement.

## Deze stap
Attempt to move to todo without a playbook description — should be rejected.`;

const blocked = await apiJson(
  `/v1/tickets/${encodeURIComponent(createdBody.slug)}/transition`,
  {
    method: "POST",
    body: JSON.stringify({ to_stage: "todo", comment }),
  },
);
assert(
  !blocked.res.ok,
  `expected refine-gate failure, got ${blocked.res.status} ${JSON.stringify(blocked.body)}`,
);
console.log("PASS refine-gate blocked transition:", blocked.res.status);

const refined = `## Context
E2E ticket used to verify backlog intake and the refine gate.

## Goal
Confirm light wishes can be created and must be refined before To do.

## What to implement
No product change — this is a verification ticket description.

## Acceptance criteria
- Description has required headings
- Transition backlog → todo succeeds after refine
`;

const updated = await apiJson(`/v1/tickets/${encodeURIComponent(createdBody.slug)}`, {
  method: "PATCH",
  body: JSON.stringify({ description: refined }),
});
assert(updated.res.ok, `update failed: ${updated.res.status} ${JSON.stringify(updated.body)}`);

const moved = await apiJson(
  `/v1/tickets/${encodeURIComponent(createdBody.slug)}/transition`,
  {
    method: "POST",
    body: JSON.stringify({ to_stage: "todo", comment }),
  },
);
assert(moved.res.ok, `transition after refine failed: ${moved.res.status} ${JSON.stringify(moved.body)}`);
console.log("PASS refined ticket moved to todo");

const loggedOut = await fetch(`${web}/api/auth/logout`, {
  method: "POST",
  headers: { Cookie: cookie },
});
assert(loggedOut.ok, `logout failed: ${loggedOut.status}`);
const clearedCookie = (loggedOut.headers.get("set-cookie") ?? "").split(";")[0];
const afterLogout = await postTicket(
  { project: "traceai", title: "after logout", description: "should fail" },
  clearedCookie,
);
assert(
  afterLogout.status === 401,
  `expected 401 after logout, got ${afterLogout.status}`,
);
console.log("PASS logout revokes create rights");

console.log("ALL E2E CHECKS PASSED");
