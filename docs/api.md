# REST API

`slab-email` exposes:

- `GET /health` (cheap)
- `GET /api/*` for admin + operational APIs
- `POST /mcp` for MCP JSON-RPC transport

All `api/*` endpoints return JSON.

## Authentication

Two auth domains are used:

- **Admin token**
  - Header: `Authorization: Bearer <SLAB_EMAIL_ADMIN_KEY>`
  - Required for account/profile setup and management.
- **Connector token**
  - Header: `Authorization: Bearer <connectorToken>`
    -profile token required for all operational account actions and MCP.

## Common error response

```json
{
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "..."
  }
}
```

Known error codes include:

- `ACCOUNT_NOT_FOUND`
- `ACCOUNT_DISABLED`
- `PERMISSION_DENIED`
- `AUTH_REQUIRED`
- `PROVIDER_UNAVAILABLE`
- `MESSAGE_NOT_FOUND`
- `SEND_DISABLED`
- `IDEMPOTENCY_CONFLICT`
- `SEND_OUTCOME_UNKNOWN`
- `INVALID_CONFIGURATION`
- `RATE_LIMITED`
- `STATE_INVALID`
- `STATE_EXPIRED`
- `INVALID_INPUT`
- `INTERNAL_ERROR`

## Admin endpoints (`/api/*`)

### `GET /api/health`

Admin-only. Returns service health.

### `POST /api/accounts/proton-bridge`

Create Proton Bridge account.

```json
{
  "emailAddress": "ventas@clasific.ar",
  "displayName": "Ventas",
  "imapHost": "127.0.0.1",
  "imapPort": 1143,
  "imapTlsMode": "ssl",
  "smtpHost": "127.0.0.1",
  "smtpPort": 1025,
  "smtpTlsMode": "starttls",
  "username": "bridge-user",
  "password": "bridge-generated-password"
}
```

### `POST /api/accounts/imap-smtp`

Generic IMAP/SMTP account with same payload as Proton Bridge route.

### `GET /api/accounts`

With the admin key, returns all account metadata. With a connector token,
returns only accounts visible to that profile. Neither response includes
credentials.

### `GET /api/accounts/:id`

Returns account metadata and caps (no secrets).

### `PATCH /api/accounts/:id`

Patch account metadata/config and optionally credentials (`username`, `password`).
`POST` remains available as a backwards-compatible alias.

### `DELETE /api/accounts/:id`

Delete account and secrets.

### `POST /api/accounts/:id/enable`

Enable account.

### `POST /api/accounts/:id/disable`

Disable account.

### `POST /api/accounts/:id/test`

Run provider connectivity check (IMAP+SMTP or OAuth-protected provider).

Response:

```json
{
  "status": "ok",
  "latencyMs": 321,
  "provider": "proton_bridge",
  "message": "IMAP+SMTP verified"
}
```

### `POST /api/accounts/gmail/connect`

Starts OAuth flow and returns auth URL + state.

```json
{
  "authorizationUrl": "https://accounts.google.com/...",
  "state": "random-state",
  "expiresAt": 1234567890
}
```

### `GET /api/settings/google-oauth`

Returns admin-visible configuration metadata. It never returns the client
secret.

```json
{
  "configured": true,
  "clientId": "example.apps.googleusercontent.com",
  "hasClientSecret": true,
  "source": "stored",
  "updatedAt": "2026-08-20T18:00:00.000Z"
}
```

### `PATCH /api/settings/google-oauth`

Creates or rotates the encrypted Google OAuth configuration. Once configured,
omit `clientSecret` to keep the stored value while updating the client ID.

```json
{
  "clientId": "example.apps.googleusercontent.com",
  "clientSecret": "write-only"
}
```

### `GET /api/inbound/events`

Returns durable inbound metadata events in ascending ID order. Query parameters:

- `after`: exclusive numeric event cursor (default `0`)
- `accountId`: optional account UUID filter
- `limit`: `1`–`100` (default `100`)

The response `nextCursor` is the last returned event ID, or `null` when no rows
were returned. Events intentionally omit message bodies and snippets. Consumers
can fetch a message through the scoped mail API using `accountId` and `messageId`.

### `GET /api/inbound/status`

Returns per-account poll baseline, last-success timestamp, resumable scan cursor,
and last error. An account with `initializedAt: null` has not completed its safe
baseline and will not emit events yet. A non-null `scanCursor` means the bounded
scan will continue on the next poll.

### `POST /api/inbound/poll`

Runs one inbound discovery pass. Concurrent requests share the same in-flight
pass. This endpoint and both inbound read endpoints require the admin token.

### `POST /api/access-profiles`

Create access profile.

```json
{
  "name": "Sales Email",
  "readEnabled": true,
  "draftEnabled": true,
  "sendEnabled": true,
  "accountIds": ["acc-..."]
}
```

### `GET /api/access-profiles`

List profiles (admin only).

### `GET /api/access-profiles/:id`

Get profile.

### `PATCH /api/access-profiles/:id`

Update profile.

### `DELETE /api/access-profiles/:id`

Delete profile.

### `POST /api/access-profiles/:id/tokens`

Create scoped connector token (one-time secret return).

```json
{
  "token": "raw-token",
  "id": "token-id",
  "prefix": "a1b2c3d4"
}
```

### `GET /api/access-profiles/:id/tokens`

List metadata of tokens.

### `DELETE /api/access-profiles/:id/tokens/:tokenId`

Revoke token.

## Operational endpoints (`/api/mail/*`)

### `GET /api/mail/search`

Authenticated by connector token.

Query params:

- `accountId` (required)
- `query`, `from`, `to`, `subject`, `since`, `before`
- `unread` (`true|false`)
- `limit` (max 100, default 20)
- `cursor` (pagination offset token)

Returns compact messages without bodies:

```json
{
  "items": [
    {
      "id": "123",
      "accountId": "acc-...",
      "threadId": "thr-...",
      "from": { "address": "noreply@example.com" },
      "to": [{ "address": "ventas@clasific.ar" }],
      "subject": "Invoice #1",
      "date": "2026-01-01T10:00:00.000Z",
      "snippet": "..."
    }
  ],
  "nextCursor": "20"
}
```

### `GET /api/mail/messages/:accountId/:messageId`

Returns full message body and headers.

```json
{
  "id": "123",
  "accountId": "acc-...",
  "from": { "address": "noreply@example.com" },
  "to": [{ "address": "ventas@clasific.ar" }],
  "subject": "Invoice #1",
  "text": "...",
  "html": "...",
  "headers": {
    "message-id": "<abc>",
    "in-reply-to": "<def>"
  }
}
```

### `GET /api/mail/threads/:accountId/:threadId`

Returns array of messages in thread when provider supports threads.

### `POST /api/mail/drafts`

Create remote draft.

```json
{
  "accountId": "acc-...",
  "to": ["person@company.com"],
  "cc": [],
  "bcc": [],
  "subject": "Follow-up",
  "text": "Draft content",
  "html": "<p>Draft content</p>"
}
```

### `POST /api/mail/send`

Idempotent send.

```json
{
  "accountId": "acc-...",
  "to": ["person@company.com"],
  "cc": [],
  "bcc": [],
  "subject": "Hello",
  "text": "Hi team",
  "html": "<p>Hi team</p>",
  "idempotencyKey": "abc-unique-key"
}
```

Response:

```json
{
  "status": "sent",
  "providerMessageId": "..."
}
```

A duplicate idempotency key returns a prior successful result without another
send. Confirmed failures may be retried with the same key; unresolved or
unknown outcomes fail closed rather than risking a duplicate message.

### `POST /api/mail/reply`

Send reply linked to message.

```json
{
  "accountId": "acc-...",
  "messageId": "m-123",
  "to": ["customer@example.com"],
  "text": "Thanks for reaching out",
  "replyAll": false,
  "idempotencyKey": "reply-unique-key"
}
```

## Gmail callback

`GET /api/oauth/google/callback?code=...&state=...`

- Validates `state` + expiry.
- Exchanges code with PKCE verifier.
- Stores encrypted refresh token for newly connected Gmail account.

## Notes

- `GET /api/accounts` accepts either admin auth or a connector-scoped token;
  all `/api/mail/*` routes require connector scope.
- Admin operations never return secrets.
- Secrets are stored encrypted, never in plain text.
