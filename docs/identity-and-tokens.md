# TraceAI identity & token model

## Boundary

| Layer | Credential | Who holds it |
|---|---|---|
| Agents (Cursor / Claude) | TraceAI personal token `trc_…` | User / agent config |
| TraceAI API | Validates `trc_…`, resolves actor + scopes | TraceAI server |
| Aurora CMS | Website management token or user PAT | TraceAI server only |

Agents never receive Aurora credentials. Aurora is an implementation detail of storage.

## Entities

### TraceAIUser

- `id` — stable cuid-like id (`usr_…`)
- `email` — unique login label
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
| `admin` | user/token management |

Default agent token scopes: all except `admin` unless explicitly granted.

## Auth flow

1. Client sends `Authorization: Bearer trc_…`.
2. API hashes token, looks up active (non-revoked, non-expired) row.
3. Loads user; rejects if `disabled`.
4. Checks required scope for the route.
5. Sets request actor = `{ userId, name, email, tokenId }`.
6. Domain writes use actor name for `created_by` / `author` — clients cannot spoof.

## Audit

Each mutating API call appends an audit row: `action`, `resourceType`, `resourceId`, `actorUserId`, `actorTokenId`, `requestId`, `createdAt`, optional `meta` JSON.
