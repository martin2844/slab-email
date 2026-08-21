# slab-email

Headless email connector for AI agents via REST and MCP.

`slab-email` is a local-first microservice that standardizes mailbox access behind a normalized API and MCP tool surface.

It is designed for `slab-agents` and other AI runtimes that need controlled access to multiple email accounts with secure credentials handling.

## What is it?

`slab-email` is not an email UI.

It provides:

- Normalized read/search/create/send capabilities over email providers.
- Admin REST for account and access-profile management.
- MCP server for LLM/tooling clients.
- Provider-level adapters for:
  - Proton via Proton Mail Bridge (mandatory).
  - Generic IMAP/SMTP.
  - Gmail via OAuth2 + Gmail API.
- Encrypted credential storage in SQLite.
- Scoped connector tokens with per-profile capabilities.
- Send idempotency and basic anti-loop rate limiting.

## Architecture

High-level flow:

- `slab-agents` calls `/mcp` with a scoped connector token.
- REST admin endpoints configure providers and access profiles.
- Accounts are stored in SQLite; credentials are encrypted at rest.
- At request time, provider instances are created from account config + decrypted secret.
- `slab-email` executes operations against provider APIs (IMAP/SMTP or Gmail API).

```text
slab-agents (REST/MCP) -> slab-email
                             |
                             +-> sqlite (config + encrypted secrets)
                             +-> providers
                                 + proton_bridge -> Proton Mail Bridge (local IMAP/SMTP)
                                 + imap_smtp    -> Any IMAP/SMTP
                                 + gmail        -> Gmail API (OAuth2)
```

## Features

- Multi-account support:
  - connect and manage multiple accounts simultaneously.
- Provider abstraction:
  - Proton Bridge + IMAP/SMTP generic + Gmail.
- Connector-scoped permissions:
  - read / draft / send.
- Idempotent send/reply with `idempotencyKey`.
- Threaded read/list payloads and full message hydration.
- Encrypted secrets using `AES-256-GCM`.
- Access tokens scoped to profiles.
- Admin API and MCP API separated by token requirements.
- Docker and CI ready.

## Stack

- Node.js + TypeScript
- Express 5
- SQLite (`better-sqlite3`)
- Zod
- MCP SDK (`@modelcontextprotocol/sdk`)
- IMAP/SMTP: `imapflow`, `nodemailer`
- Gmail: `googleapis` / `google-auth-library`

## Quickstart

### 1) Start local service

```bash
npm install
cp .env.example .env
```

Set values in `.env` and run:

```bash
export SLAB_EMAIL_ADMIN_KEY=change-me
export SLAB_EMAIL_MASTER_KEY=<32-byte base64 or 64-hex key>
npm run dev
```

Expected:

- `GET /health` → `{"status":"ok"}`.
- `GET /ready` → SQLite and packaged migrations are ready.
- `/mcp` available on `POST /mcp`.

### 2) Register a scoped profile + token

Use admin token for account/profile management and connector token for regular usage.

## Configuration

Required / relevant environment variables:

- `HOST` (default `127.0.0.1`)
- `PORT` (default `6981`)
- `DATABASE_PATH` (default `./data/slab-email.db`)
- `SLAB_EMAIL_ADMIN_KEY` (required)
- `SLAB_EMAIL_ADMIN_KEY_FILE` (mounted-file alternative)
- `SLAB_EMAIL_MASTER_KEY` (required, 32-byte key)
- `SLAB_EMAIL_MASTER_KEY_FILE` (mounted-file alternative)
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_CLIENT_SECRET_FILE` (mounted-file alternative)
- `GOOGLE_REDIRECT_URI` (default `http://127.0.0.1:6981/api/oauth/google/callback`)
- `MAX_SENDS_PER_ACCOUNT_PER_HOUR` (default `60`)
- `MCP_ALLOWED_ORIGINS` (comma-separated)
- `MCP_ALLOWED_ORIGINS_HOSTS` (comma-separated)
- `PUBLIC_ADMIN_ALLOWED_ORIGINS` (comma-separated)
- `SKIP_MIGRATIONS` (set to `true` only after the one-shot migration command succeeds)

Direct secret values and their corresponding `_FILE` variables are mutually
exclusive. The unified self-hosted stack uses mounted secret files. Run its
deterministic migration job with:

```bash
docker run --rm -v slab-email-data:/data ghcr.io/martin2844/slab-email:<version> \
  node dist/db/migrate.js
```

See `.env.example` for the minimum bootstrap.

## Proton Bridge setup

The image includes the official Proton Mail Bridge headless backend and a
private process controller. Connect an account from Slab Agents or the stack
installer. The Proton password and second-factor values travel only through the
admin request and private process pipes; they are never stored. `slab-email`
stores only the generated Bridge mailbox credential encrypted at rest.

Manual/external Bridge remains supported through
`POST /api/accounts/proton-bridge`. This is useful when Bridge already runs on
the same host/network. A Bridge on a laptop or Windows workstation is not
reachable from a remote VPS unless that network path is explicitly provided.

Managed Bridge requires a paid Proton plan. It is built for amd64 and arm64
from Proton's verified v3.26.0 source archive with a compatible patched Go
toolchain. The image preserves Proton Bridge's GPLv3 license and the exact
corresponding source archive beside the binary.

See [docs/proton.md](docs/proton.md).

## Gmail setup

1. Create Google Cloud OAuth credentials for a Web application.
2. Configure them from Slab Agents Settings (encrypted service storage), or set
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` in `.env`.
3. Register the exact Slab Agents callback URI shown in Settings.
4. Start service and use:
   - `POST /api/accounts/gmail/connect` to obtain `authorizationUrl`.
5. Complete OAuth in browser.
6. Callback:
   - `GET /api/oauth/google/callback`
7. Gmail account is stored with refresh token in encrypted DB.

See [docs/gmail.md](docs/gmail.md).

## REST API

- Base:
  - `GET /health`
  - `GET /ready`
  - `/api/*`
  - `POST /mcp`
- Authentication:
  - Admin endpoints: `Bearer <SLAB_EMAIL_ADMIN_KEY>`
  - Operational + MCP: `Bearer <scoped connector token>`

See [docs/api.md](docs/api.md) for full request/response examples.

## MCP

Endpoint: `POST /mcp`

Tools:

- `email_list_accounts`
- `email_search`
- `email_get_message`
- `email_list_threads`
- `email_get_thread`
- `email_create_draft`
- `email_send`
- `email_reply`

See [docs/mcp.md](docs/mcp.md) for tool payloads and usage.

## Security model

- `SLAB_EMAIL_MASTER_KEY` is required to encrypt/decrypt provider secrets.
- Secrets are never returned by admin REST/MCP.
- Scoped connector tokens replace admin key in operational contexts.
- Read/write/send permissions are enforced per access profile.
- Send is idempotent by `(accountId, idempotencyKey)`.
- Unknown send outcomes are surfaced as `SEND_OUTCOME_UNKNOWN` and never auto-retried blindly.
- Per-account send throttling default: `MAX_SENDS_PER_ACCOUNT_PER_HOUR`.
- Logs redact likely sensitive keys.

## Data model

- `email_accounts`: account metadata and provider config (without secrets).
- `email_account_secrets`: encrypted payload (`username`, `password`, `refreshToken`).
- `access_profiles` + `access_profile_accounts`.
- `access_tokens`: hashed connector tokens.
- `send_operations`: status + audit fields and `idempotency_key`.

See [docs/architecture.md](docs/architecture.md).

## Docker

- `Dockerfile` for image build.
- `docker-compose.yml` for local runtime.

Note: Proton Bridge is local-first. If running Bridge outside Docker on host, configure connectivity carefully (host networking or equivalent) because the container cannot assume access to host `127.0.0.1` credentials by default.

## Development

```bash
npm run dev      # start with hot reload
npm test         # run test suite
npm run lint
npm run typecheck
npm run build
npm start        # run production bundle
```

## Testing

Domain tests cover:

- Account lifecycle and secret encryption
- OAuth state validation
- Profile scoping and permissions
- Search/list vs get payload separation
- Send idempotency
- Unknown send outcome behavior
- MCP auth/scoping/tool execution

## Limitations (MVP)

- No attachments support.
- No mailbox sync engine, local full-text search index, or webhook push sync.
- No batching/outbound campaign workflows.
- No webmail UI in this service.

## slab-agents integration

If `../slab-agents` exists, use [docs/slab-agents-integration.md](docs/slab-agents-integration.md) for integration contract and configuration.

## License

MIT
