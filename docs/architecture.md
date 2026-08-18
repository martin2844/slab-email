# Architecture

`slab-email` separates administration, policy, provider adapters, and execution layers.

## Runtime layers

1. **HTTP/Routing layer**
   - `Express` routes for `/health`, `/api/*`, `/mcp`.
   - Auth middleware:
     - `requireAdmin`
     - `requireProfileToken`
   - Error mapping to structured error payloads.

2. **Service layer**
   - `AccountService`: account CRUD + provider factory wiring.
   - `AccessProfileService`: profiles, capability sets, token metadata.
   - `MailService`: permission checks + operation orchestration.

3. **Provider layer**
   - `Provider` interface:
     - verify, search, get message/thread, create draft, send/reply.
   - `GenericImapSmtpProvider` for IMAP/SMTP.
   - `ProtonBridgeProvider` extends generic IMAP/SMTP config (Bridge-specific semantics).
   - `GmailProvider` for OAuth2/API calls.

4. **Persistence / crypto**
   - `better-sqlite3` database.
   - `AES-256-GCM` encrypt/decrypt for credentials.
   - Hash-only token storage.

## SQLite schema (implemented)

- `email_accounts`
  - `config_json` excludes secrets.
- `email_account_secrets`
  - encrypted JSON payload (`username`, `password`, `refreshToken`).
- `access_profiles`
- `access_profile_accounts`
- `access_tokens` (token hash + prefix + timestamps)
- `send_operations`
- `oauth_states`

## Provider abstraction

- Account records define provider type (`proton_bridge`, `imap_smtp`, `gmail`).
- Secrets are resolved at request time from `email_account_secrets`.
- `AccountService` creates provider objects through `createProvider`.

## Scopes / permissions

- Access profile fields:
  - `readEnabled`, `draftEnabled`, `sendEnabled`, `accountIds`.
- Scoped token maps to exactly one profile.
- `MailService` enforces:
  - endpoint-level auth + profile membership in account list
  - capability checks (`read`, `draft`, `send`)
  - account enabled state

## Send idempotency

- `POST /api/mail/send` and `POST /api/mail/reply` require `idempotencyKey`.
- `send_operations` stores:
  - key, status (`pending|sent|failed|unknown`), provider IDs.
- On repeated key:
  - `sent` -> return prior result
  - `unknown` -> `SEND_OUTCOME_UNKNOWN`, no blind retry
  - pending/in-progress -> `IDEMPOTENCY_CONFLICT`

## Audit / observability

- Per-send audit data is persisted in `send_operations`.
- No message bodies are persisted.
- Runtime logger redacts sensitive keys in metadata.

## Anti-loop guard

- `MAX_SENDS_PER_ACCOUNT_PER_HOUR` (default `60`) prevents excessive outbound sends per account/profile.

## Non-goals (MVP)

- No attachment end-to-end operations
- No mailbox replication or local index
- No campaign/automation campaign mode
- No webmail UI

