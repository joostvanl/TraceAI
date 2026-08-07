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

# Server-only — UI login (one shared account)
TRACEAI_UI_USER=joost
TRACEAI_UI_PASSWORD=choose-a-password
# Optional; defaults to the password, so rotating it also invalidates sessions
TRACEAI_SESSION_SECRET=
```

Boards stay readable without logging in. Creating a ticket requires a session: `/login` verifies the credentials above and sets an HttpOnly, HMAC-signed cookie (`traceai_session`, 7 days). `/api/tickets` returns **401** without it and otherwise proxies to the TraceAI API with the server-side `trc_…` token. Tickets land in **Backlog** with a light wish description; agents must refine the playbook sections before transitioning to To do.

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

### One writer: keep MCP and the board on the same API instance

The board reads its initial state straight from Aurora, but live updates come from the SSE stream of one specific API process, and the ticket event bus is in-process. So `TRACEAI_API_URL` (what MCP writes to) and `NEXT_PUBLIC_TRACEAI_EVENTS_URL` (what the board listens to) must resolve to the **same** instance.

Point them at different instances and nothing errors: every instance shares one Aurora store, so a refresh still shows the correct board while live updates silently never arrive. Both localhost origins are already allowed by the API's CORS defaults, so a local board can subscribe to the Pi instance.

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
