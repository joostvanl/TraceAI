# TraceAI

Agent-first issue tracker. Agents authenticate with **TraceAI tokens** (`trc_…`). Aurora CMS is only used server-side by the TraceAI API.

## Architecture

```
Cursor/Claude  --TRACEAI_TOKEN-->  TraceAI MCP  --HTTP-->  TraceAI API  --Aurora token-->  Aurora CMS
Human browser  --site key-->  Next.js UI  --public API-->  Aurora CMS (read)
Human browser  --session cookie-->  Next.js /api/tickets  --TRACEAI_TOKEN-->  TraceAI API (backlog create)
```

See [docs/identity-and-tokens.md](docs/identity-and-tokens.md) and
[docs/agent-playbook.md](docs/agent-playbook.md).

## Agent playbook (workflow JSON)

Working agreements are stored in each workflow’s `stages_json` as a v2 document:

- **Rich ticket descriptions** (self-contained for junior agents)
- **Comment on every transition** (`## Vorige stap` + `## Deze stap`)
- **Test report when entering review** (`## Testverslag` + `## Uitslag`)

Agents discover them via `get_project` (`agent_playbook`) / `get_workflow`
(`agent_policy`). The API enforces them on create/update/transition.

## Packages

| Package | Purpose |
|---|---|
| `apps/api` | TraceAI HTTP API + auth (users/tokens) |
| `apps/web` | Next.js UI for humans — live boards + backlog wish capture |
| `packages/auth` | Identity model, hashing, SQLite store |
| `packages/core` | Domain service + Aurora + TraceAI API clients |
| `packages/mcp` | MCP server for Cursor / Claude Code |

## Quick start

```bash
pnpm install
pnpm --filter @traceai/auth build
pnpm --filter @traceai/core build
pnpm --filter @traceai/api build
pnpm --filter @traceai/mcp build

# Server-side Aurora credential (never put this in MCP config)
# set AURORA_USER_TOKEN=aur_u_...

pnpm --filter @traceai/api bootstrap -- --email you@example.com --name "Your Name"
# → prints a trc_… token once

pnpm --filter @traceai/api start
# binds locally for development; agents/MCP use https://traceai.joostvanleeuwaarden.com

pnpm --filter @traceai/web dev
```

## MCP (Cursor)

Agents only need a TraceAI token. **Always** point `TRACEAI_API_URL` at the public API — loopback is rejected by the MCP server:

```json
{
  "mcpServers": {
    "traceai": {
      "command": "node",
      "args": ["C:/Users/joost.vanleeuwaarden/webroot/TraceAI/packages/mcp/dist/index.js"],
      "env": {
        "TRACEAI_API_URL": "https://traceai.joostvanleeuwaarden.com",
        "TRACEAI_TOKEN": "trc_YOUR_TOKEN"
      }
    }
  }
}
```

The API process holds `AURORA_USER_TOKEN` / `AURORA_MANAGEMENT_TOKEN` in its own env.

### Agent tools

- `list_projects` / `get_project` / `create_project`
- `list_tickets` / `get_ticket` / `create_ticket` / `update_ticket`
- `add_comment` / `transition_ticket`
- `list_workflows` / `get_workflow` / `create_workflow` / `update_workflow`

`created_by` / comment `author` come from the TraceAI user behind the token — clients cannot spoof them.

## Web env

`apps/web/.env.local`:

```
NEXT_PUBLIC_CMS_API_URL=https://aurora-api.joostvanleeuwaarden.com
NEXT_PUBLIC_CMS_SITE_KEY=your-site-key
NEXT_PUBLIC_TRACEAI_EVENTS_URL=https://traceai.joostvanleeuwaarden.com/events

# Server-only — New ticket form on the project board
TRACEAI_API_URL=https://traceai.joostvanleeuwaarden.com
TRACEAI_TOKEN=trc_YOUR_TOKEN

# Server-only — HMAC secret for the HttpOnly session cookie
TRACEAI_SESSION_SECRET=choose-a-long-random-secret
```

Boards and pages require a session. `/login` verifies against Aurora CMS content type `app_login` (entry `default`, fields Username + Password). The Password field is hashed in Aurora; TraceAI never reads the hash — it calls Aurora management `verify-credentials`. The web server verifies via the TraceAI API (`POST /v1/ui/login/verify`) using the server-side `trc_…` token, then sets an HttpOnly, HMAC-signed cookie (`traceai_session`, 7 days). `/api/tickets` returns **401** without a session and otherwise proxies to the TraceAI API. Tickets land in **Backlog** with a light wish description; agents must refine the playbook sections before transitioning to To do.

## Deploy on Raspberry Pi (Docker)

See [deploy/README.md](deploy/README.md). Short version on the Pi:

```bash
~/deploy-traceai.sh
# UI: http://<pi-ip>:3011  API: http://<pi-ip>:3847/health
```

## Live board (SSE)

Project boards subscribe to:

```
GET https://traceai.joostvanleeuwaarden.com/events?project=<projectSlug>
```

No bearer token required. The API publishes `ticket.created`, `ticket.updated`, `ticket.transitioned`, and `ticket.commented` after successful writes. The Next.js board updates cards in place (no full refresh).

### Durable, cross-process events

Ticket events are persisted to an append-only SQLite store (`node:sqlite`, the same driver as the auth DB — no extra dependency) with a monotonic `event_id`. `publishTicketEvent` writes to that store and notifies local subscribers; every API worker also polls the shared WAL file, so a write on **any** instance reaches SSE clients on **all** of them. Events survive process restarts and can be replayed.

- `GET /events` emits stable `id:` fields. On reconnect the browser's `EventSource` resends the last id as `Last-Event-ID` (you can also pass `?after=<event_id>`), and the API replays only the events missed since then — no hard refresh required.
- The web board loads its **initial** ticket list from the TraceAI API (`/v1/tickets`) when `TRACEAI_API_URL` + `TRACEAI_TOKEN` are set, so the live-board path has one source of truth (TraceAI → Aurora), matching the SSE stream. Without those env vars it falls back to reading Aurora directly.

Because events are durable and shared, `TRACEAI_API_URL` and `NEXT_PUBLIC_TRACEAI_EVENTS_URL` no longer have to resolve to the same process — any instance backed by the same event store works. Both localhost origins are already allowed by the API's CORS defaults, so a local board can subscribe to the Pi instance.

**API env for events:**

- `TRACEAI_EVENTS_DB` — path to the SQLite event store (default `data/traceai-events.sqlite`). For multi-instance deploys, point every worker at the **same** file (shared volume).
- `TRACEAI_EVENTS_POLL_MS` — how often each worker checks the store for events written by another process (default `750`).

Cursor sometimes leaves orphan `node …/packages/mcp/dist/index.js` processes after an MCP reload. Those keep the old `TRACEAI_API_URL` (historically localhost). The MCP server now **rejects** loopback URLs. Every tool result includes `api_base` — if it is not `https://traceai.joostvanleeuwaarden.com`, clean up and reload:

```bash
node scripts/cleanup-traceai-mcp.mjs
# then reload the `traceai` MCP server in Cursor
```

To verify the full path, listen on one instance while writing to another:

```bash
# same instance → expect LIVE_SSE_OK
node scripts/diagnose-public-sse.mjs

# deliberate mismatch (only if a local API is running) → expect TIMEOUT
LISTEN_BASE=http://localhost:3847 node scripts/diagnose-public-sse.mjs
```

### Ticket keys (TRA-42)

Every ticket gets an immutable display key `<PROJECT_KEY>-<NUMBER>` (e.g. `TRA-1`).

- Allocated server-side on create; clients cannot choose or overwrite it.
- `project.project_key` defaults to a derived prefix (`traceai` → `TRA`); `next_ticket_number` advances per project.
- Existing tickets are filled with `pnpm --filter @traceai/api backfill-ticket-keys`.
- Lookup works by slug **or** exact key via `GET /v1/tickets/:slug` / MCP `get_ticket`.
- Slugs remain the URL/technical identifier.

## Smoke

```bash
# with API running and TRACEAI_TOKEN set
pnpm --filter @traceai/mcp smoke
```

```bash
pnpm --filter @traceai/core test
```
