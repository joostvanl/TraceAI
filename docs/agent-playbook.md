# TraceAI agent playbook (workflow-embedded)

Canonical working agreements live in each workflow's `stages_json` as:

```json
{
  "version": 2,
  "agent_policy": { "...global rules..." },
  "stages": [
    {
      "key": "review",
      "name": "Review",
      "transitions": ["done", "in_progress"],
      "agent": {
        "require_comment_on_enter": true,
        "require_comment_sections_on_enter": ["## Testverslag", "## Uitslag"]
      }
    }
  ]
}
```

## How agents discover rules

1. Call `get_project` â€” response includes `agent_playbook`.
2. Call `get_workflow` â€” response includes `agent_policy` + per-stage `agent` rules.
3. The API **enforces** these rules:
   - Ticket descriptions must meet `min_description_chars` and required `##` headings.
   - Every `transition` requires a Markdown `comment`.
   - Entering `review` requires `## Testverslag` and `## Uitslag` in that comment.
   - When `agent_policy.require_tokens_used_on_transition` is true, pass `tokens_used`
     (non-negative integer LLM token delta for that step).
   - When leaving a stage with `require_tokens_estimate_on_exit`, pass `tokens_estimate`
     for the whole ticket.
   - Token counts are **self-reported** by agents; the workflow JSON is the source of
     truth for when they are required (no hard-coded stage names in the API).

## Defaults shipped with TraceAI

See `DEFAULT_WORKFLOW_DOCUMENT` in `@traceai/core`. Product defaults enable token
tracking (`require_tokens_used_on_transition` + backlog `require_tokens_estimate_on_exit`).
Live Aurora workflows must carry the same flags — code defaults alone are not enough.

## Always go through MCP / the TraceAI API

- Ticket writes MUST go through the `traceai` MCP server (or the TraceAI API it proxies).
- Do **not** fall back to writing Aurora directly. Aurora-direct writes bypass the API,
  so no SSE event is published and the live board only updates after a manual refresh.

### Recovering from an MCP `404`

A bare `TraceAI API 404` from an MCP tool almost always means the running MCP process is
**stale** (old build/env, e.g. an old `TRACEAI_API_URL` port) â€” not that the resource is
missing. The same token usually works when called directly against the API.

Fix it, do not bypass it:

1. Confirm the API is up: `GET https://traceai.joostvanleeuwaarden.com/health` â†’ `{ "status": "ok" }`.
2. Rebuild the MCP if needed: `pnpm --filter @traceai/mcp build`.
3. Reload the `traceai` MCP server in Cursor (toggle it off/on in MCP settings, or reload
   the window) so it picks up the current build and `mcp.json` env.
4. Retry `get_project` â€” it should return the project, no 404.

## Live board

- The board listens to `GET /events?project=<slug>` (SSE) published by the API on
  create / update / transition / comment.
- Only writes through the API/MCP are reflected live. The `Done` lane is ordered by the
  moment a ticket entered Done (most recently completed on top).
