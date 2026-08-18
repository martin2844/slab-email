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

- Read tools include `readOnlyHint: true`.
- Send/reply tools include write hints.

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

Returns full message fields for the selected message.

### `email_list_threads`

Inputs: `accountId`, `threadId`.

Returns thread message list when provider exposes threads.

### `email_get_thread`

Deprecated alias variant in some clients; use `email_list_threads`.

### `email_create_draft`

Inputs:

- `accountId`
- `to[]`
- `cc?[]`
- `bcc?[]`
- `subject`
- `text`
- `html?`

Creates a provider draft where supported (Gmail supported, generic IMAP/SMTP returns unsupported).

### `email_send`

Inputs:

- `accountId`
- `to[]`
- `cc?[]`
- `bcc?[]`
- `subject`
- `text`
- `html?`
- `idempotencyKey` (required)

Idempotency is enforced by `(accountId, idempotencyKey)`.

### `email_reply`

Inputs:

- `accountId`
- `messageId`
- `to?[]`
- `cc?[]`
- `text`
- `html?`
- `replyAll?`
- `idempotencyKey` (required)

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

