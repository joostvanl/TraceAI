# TraceAI

Agent-first issue tracker. Agents authenticate with **TraceAI tokens** (`trc_…`). Aurora CMS is only used server-side by the TraceAI API.

## Architecture

```
Cursor/Claude  --TRACEAI_TOKEN-->  TraceAI MCP  --HTTP-->  TraceAI API  --Aurora token-->  Aurora CMS
Human browser  --site key-->  Next.js UI  --public API-->  Aurora CMS (read-only)
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
| `apps/web` | Read-only Next.js UI for humans |
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
# API on http://127.0.0.1:3847

pnpm --filter @traceai/web dev
```

## MCP (Cursor)

Agents only need a TraceAI token:

```json
{
  "mcpServers": {
    "traceai": {
      "command": "node",
      "args": ["C:/Users/joost.vanleeuwaarden/webroot/TraceAI/packages/mcp/dist/index.js"],
      "env": {
        "TRACEAI_API_URL": "http://127.0.0.1:3847",
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
NEXT_PUBLIC_TRACEAI_EVENTS_URL=http://127.0.0.1:3847/events
```

## Deploy on Raspberry Pi (Docker)

See [deploy/README.md](deploy/README.md). Short version on the Pi:

```bash
~/deploy-traceai.sh
# UI: http://<pi-ip>:3011  API: http://<pi-ip>:3847/health
```

## Live board (SSE)

Project boards subscribe to:

```
GET http://127.0.0.1:3847/events?project=<projectSlug>
```

No bearer token required. The API publishes `ticket.created`, `ticket.updated`, `ticket.transitioned`, and `ticket.commented` after successful writes. The Next.js board updates cards in place (no full refresh).

Set `NEXT_PUBLIC_TRACEAI_EVENTS_URL` in `apps/web/.env.local` if the API is not on `3847`.

## Smoke

```bash
# with API running and TRACEAI_TOKEN set
pnpm --filter @traceai/mcp smoke
```
