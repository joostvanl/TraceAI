# TraceAI identity & token model

## Boundary

| Layer | Credential | Who holds it |
|---|---|---|
| Agents (Cursor / Claude) | TraceAI personal token `trc_…` | User / agent config |
| TraceAI API | Validates `trc_…`, resolves actor + scopes | TraceAI server |
| Aurora CMS | Website management token or user PAT | TraceAI server only |
| Web UI humans | Username + password in Aurora `traceai_user` (preferred) or legacy `app_login` / `default` | Managed via TraceAI Admin UI; password hashed in Aurora; verified via TraceAI → Aurora `verify-credentials` |

Agents never receive Aurora credentials. Aurora is an implementation detail of storage.

### Web UI login

- Preferred: Aurora content type `traceai_user` (personal accounts).
- Legacy fallback: `app_login` entry `default`.
- Web container holds `TRACEAI_TOKEN` + `TRACEAI_SESSION_SECRET` (+ human proxy secret) only; it never holds `AURORA_*` tokens.
- Login flow: browser → `POST /api/auth/login` → TraceAI `POST /v1/ui/login/verify` → Aurora `verify-credentials` → HttpOnly session cookie (`traceai_session`).

### Self-service API tokens (TRA-54)

Personal web users can create/list/revoke **their own** agent tokens without CLI or `admin` scope:

| Layer | Path |
|---|---|
| UI | `/projects/:slug/tokens` (project left menu after login); `/account/tokens` remains a valid direct URL |
| Web proxy | `/api/account/tokens`, `/api/account/tokens/:id/revoke` |
| API | `GET/POST /v1/me/tokens`, `POST /v1/me/tokens/:id/revoke` |

Rules:

- Requires signed human identity (web session proxy). **Legacy shared login cannot create tokens.**
- Ownership is derived server-side from `identity.slug`. Clients never send `userId`.
- Bridge: each UI slug maps to an AuthStore user with email `ui+{slug}@users.traceai.local` (auto-provisioned on first token request).
- Create returns the raw `trc_…` **once**; list/revoke expose only public fields (prefix, never hash/raw).
- List returns only **non-revoked** tokens; revoked tokens disappear from the UI.
- Create accepts optional `expiresAt` (ISO); the account UI offers presets (never / 7d / 30d / 90d / 1y).
- Self-service scopes default to agent scopes and **cannot** include `admin` (stripped server-side).
- Admin routes `/v1/admin/tokens` remain for operators with `admin` scope.
- CLI (`pnpm --filter @traceai/api create-token`) remains supported.

## Entities

### TraceAIUser (AuthStore)

- `id` — stable cuid-like id (`usr_…`)
- `email` — unique login label (for self-service UI users: `ui+{slug}@users.traceai.local`)
- `name` — display name used as actor in tickets/comments
- `status` — `active` | `disabled`
- `createdAt` / `updatedAt`

### TraceAIToken

- `id` — `tok_…`
- `userId` — owning user
- `name` — human label (e.g. "Cursor laptop")
- `tokenPrefix` — first characters for UI hints (`trc_abcd…`)
- `tokenHash` — SHA-256 hex of the raw token (never store raw)
- `scopes` — JSON string array
- `expiresAt` — optional ISO datetime
- `revokedAt` — set on revoke
- `lastUsedAt` — updated on successful auth
- `createdAt`

Raw token format: `trc_` + 43 chars of base64url randomness. Shown **once** at creation.

## Scopes

| Scope | Allows |
|---|---|
| `projects:read` | list/get projects |
| `projects:write` | create projects |
| `tickets:read` | list/get tickets |
| `tickets:write` | create/update/transition tickets |
| `comments:write` | add comments |
| `workflows:read` | list/get workflows |
| `workflows:write` | create/update workflows |
| `wiki:read` | list/get wiki pages |
| `wiki:write` | create/update wiki pages |
| `admin` | user/token management (not grantable via self-service UI) |

Default agent token scopes: all except `admin` unless explicitly granted via admin/CLI.

## Auth flow

1. Client sends `Authorization: Bearer trc_…`.
2. API hashes token, looks up active (non-revoked, non-expired) row.
3. Loads user; rejects if `disabled`.
4. Checks required scope for the route.
5. Sets request actor = `{ userId, name, email, tokenId }`.
6. Domain writes use actor name for `created_by` / `author` — clients cannot spoof.

Human-gated routes (inbox, self-service tokens, …) additionally require the web proxy human headers; identity is HMAC-signed and not client-spoofable.

## Audit

Each mutating API call appends an audit row: `action`, `resourceType`, `resourceId`, `actorUserId`, `actorTokenId`, `requestId`, `createdAt`, optional `meta` JSON. Self-service token create/revoke set `meta.selfService: true` and the UI slug.
