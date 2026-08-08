#!/usr/bin/env node
/**
 * Smoke test against TraceAI API (not Aurora directly).
 * Requires TRACEAI_API_URL + TRACEAI_TOKEN and a running API.
 */
import { TraceApiClient } from "@traceai/core";

async function main() {
  const apiUrl = process.env.TRACEAI_API_URL?.replace(/\/$/, "");
  if (!apiUrl) {
    throw new Error("Set TRACEAI_API_URL (required; no localhost default)");
  }
  const token = process.env.TRACEAI_TOKEN;
  if (!token) {
    console.error("Set TRACEAI_TOKEN");
    process.exit(1);
  }

  const client = new TraceApiClient({ apiUrl, token });
  const me = await client.me();
  console.log("me:", JSON.stringify(me));

  const projects = await client.listProjects();
  console.log(
    "projects:",
    Array.isArray(projects)
      ? projects.map((p) => p.slug).join(", ")
      : projects,
  );

  const ticket = await client.createTicket({
    project: "traceai",
    title: `Auth smoke ${new Date().toISOString()}`,
    description: `## Context
Smoke test of TraceAI API auth and transition validation.

## Goal
Verify token auth, ticket create, transition-with-comment, and comment create.

## What to implement
No product change — this ticket is disposable smoke data.

## Acceptance criteria
- Ticket created with authenticated \`created_by\`
- Transition to todo succeeds with required comment headings
- Comment create succeeds
`,
    priority: "low",
  });

  console.log("created:", ticket.slug, "by", ticket.created_by);
  const moved = await client.transitionTicket(
    ticket.slug,
    "todo",
    `## Vorige stap
Ticket just created in backlog/default stage.

## Deze stap
Smoke transition to todo after auth check.`,
    { tokens_estimate: 1000, tokens_used: 50 },
  );
  console.log("transitioned:", moved.stage);
  await client.addComment({
    ticket: ticket.slug,
    body: "Smoke comment via TraceAI token.",
  });
  console.log("SMOKE_OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
