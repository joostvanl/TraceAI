/**
 * E2E checks for the New ticket MVP against the public TraceAI stack.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const mcp = JSON.parse(
  readFileSync(join(homedir(), ".cursor", "mcp.json"), "utf8").replace(/^\uFEFF/, ""),
);
const token = mcp.mcpServers.traceai.env.TRACEAI_TOKEN;
const secret = readFileSync(join("scripts", ".create-secret.local"), "utf8").trim();
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

const html = await (await fetch(`${web}/projects/traceai`)).text();
assert(
  html.includes("New ticket") || html.includes("create-ticket"),
  "board missing New ticket UI",
);
console.log("PASS board shows create UI");

const bad = await fetch(`${web}/api/tickets`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    project: "traceai",
    title: "should fail",
    description: "short wish",
    secret: "definitely-wrong",
  }),
});
assert(bad.status === 401, `expected 401 for bad secret, got ${bad.status}`);
console.log("PASS bad secret → 401");

const title = `Wish E2E ${new Date().toISOString().slice(11, 19)}`;
const createdRes = await fetch(`${web}/api/tickets`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    project: "traceai",
    title,
    description: "Ik wil een lichte wens vastleggen zonder playbook-secties.",
    priority: "low",
    secret,
  }),
});
const createdBody = await createdRes.json();
assert(
  createdRes.status === 201,
  `create failed: ${createdRes.status} ${JSON.stringify(createdBody)}`,
);
assert(createdBody.stage === "backlog", `expected backlog, got ${createdBody.stage}`);
console.log("PASS light create → backlog", createdBody.slug);

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

console.log("ALL E2E CHECKS PASSED");
