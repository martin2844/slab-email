# MCP

`slab-email` exposes a Streamable HTTP MCP server at:

`POST /mcp`

## Host / auth / security

- Bind host default: `127.0.0.1`
- `Authorization: Bearer <connectorToken>` required
- MCP endpoint performs origin validation:
  - `MCP_ALLOWED_ORIGINS` (host:port list)
  - `MCP_ALLOWED_ORIGINS_HOSTS` (hostname allow-list for local binding safety)

Only scoped connector tokens are accepted (admin token is not valid here).

## Tool annotations

Every tool declares all four MCP safety hints explicitly:

- Account discovery is read-only, idempotent, non-destructive, and closed-world.
- Mail reads are read-only, idempotent, and non-destructive. They are open-world
  because messages may contain content from external senders.
- Draft creation is additive and non-destructive, but not idempotent: repeating a
  call may create another draft.
- Send and reply are additive, non-destructive, open-world operations. They are
  idempotent because both require a caller-provided `idempotencyKey`.

Annotations describe behavior for host UX and retry policy. Access profiles and
server-side permission checks remain the security boundary.

## Tool list

### `email_list_accounts`

List accounts visible for the current access profile.

- **Output (compact)**:
  - `id`
  - `email`
  - `provider`
  - `capabilities`

### `email_search`

Inputs: `accountId`, optional `query`, `from`, `to`, `subject`, `since`, `before`, `unread`, `limit`, `cursor`.

Returns compact list payload (`items` + optional `nextCursor`) without full body.

### `email_get_message`

Inputs: `accountId`, `messageId`.

Returns full message fields for the selected message, including
`attachments: [{ id, filename, contentType, size, inline? }]`.

### `email_get_attachment`

Inputs: `accountId`, `messageId`, `attachmentId` (from `email_get_message`).

Returns `{ id, filename, contentType, size, encoding: "text" | "base64", content, truncated }`.
Text-like files are truncated to `MAX_ATTACHMENT_TEXT_BYTES` (default 200 KB);
binary files are returned as base64 up to `MAX_ATTACHMENT_BASE64_BYTES` (default
5 MB), otherwise `ATTACHMENT_TOO_LARGE`. Providers without download support
return `NOT_SUPPORTED`. Requires read permission.

### `email_suppress`

Inputs: `address` (email), `reason` (1–1000 chars), optional `scope`
(`address` default, or `domain` to suppress the address's whole domain).

Records an opt-out shared by every account: `email_send` then refuses that
recipient (`RECIPIENT_SUPPRESSED`). Idempotent; returns
`{ suppressed: true, created, entry: { id, kind, value, createdAt } }`.
Available to any profile with read, draft or send permission.

### `email_list_threads`

Inputs: `accountId`, `threadId`.

Returns thread message list when provider exposes threads.

### `email_create_draft`

Inputs:

- `accountId`
- `to[]`
- `cc?[]`
- `bcc?[]`
- `subject`
- `text`
- `html?`
- `attachments?[]`: `{ filename, contentType, contentBase64 }`

Creates a provider draft where supported (Gmail supported, generic IMAP/SMTP returns unsupported).

### `email_send`

Inputs:

- `accountId`
- `to[]`
- `cc?[]`
- `bcc?[]`
- `subject`
- `text` (plain-text body, required)
- `html?` (HTML alternative; sent as multipart/alternative)
- `attachments?[]`: `{ filename, contentType, contentBase64 }` (default max 10 files, 10 MB decoded)
- `idempotencyKey` (required)
- `expectedFrom` (required; exact sender from `email_list_accounts`)

Idempotency is enforced by `(accountId, idempotencyKey)`. New sends are refused
when any recipient is suppressed (`RECIPIENT_SUPPRESSED`) or the account reached
its rolling 24h cap (`DAILY_SEND_LIMIT_REACHED`, with `details.retryAt`).

### `email_reply`

Inputs:

- `accountId`
- `messageId`
- `expectedFrom` (required; exact sender from `email_list_accounts`)
- `to[]` (required; exactly the original sender from `email_get_message`)
- `expectedSubject` (required; exact approved reply subject)
- `text`
- `html?`
- `attachments?[]`
- `idempotencyKey` (required)

Replies only count toward the hourly limit, not the daily cap, and may answer
suppressed senders.

## MCP example

Sample client config:

```json
{
  "url": "http://127.0.0.1:6981/mcp",
  "headers": {
    "Authorization": "Bearer <scoped-connector-token>"
  }
}
```

## Notes

- MCP output intentionally avoids duplicating large payloads in both content and structured content.
- Large/unsafe fields (secrets) are never emitted by MCP.
