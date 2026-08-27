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
   - `InboundEventService`: bounded polling, baseline establishment, and durable
     metadata event discovery for readable accounts.

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
- `inbound_seen_messages` (deduplication boundary)
- `inbound_events` (append-only metadata; no message body or snippet)
- `inbound_poll_state` (baseline/checkpoint/error state)

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

## Inbound event discovery

- The first successful scan exhausts the provider inbox as a baseline and emits
  no events, so enabling the feature cannot replay existing mail as new work.
- Each invocation processes at most 5,000 messages. Larger baselines or catch-up
  scans persist their provider cursor and resume on the next invocation; each page
  and its next cursor are committed in one scan-identity-guarded transaction.
- Expired or rejected provider cursors restart the same logical scan from page one.
  Partial page writes are deduplicated and do not become a false old-mail boundary.
- Later scans use an overlap window and stop at an already-seen message boundary.
  Account/message uniqueness makes retries safe.
- Only enabled accounts with read and search capabilities are polled.
- Discovery is provider-native inbox-only: Gmail uses its inbox label, Microsoft
  Graph uses the inbox folder, IMAP/Resend use inbound endpoints, and AgentMail
  filters self-sent messages while retaining its provider pagination.
- Graph requests opt into immutable message IDs. IMAP scan epochs combine
  `UIDVALIDITY` with a non-secret connection-identity fingerprint, preventing
  mailbox rebuilds or account repoints from corrupting deduplication.
- IMAP continuation cursors use a UID boundary bound to that same identity epoch,
  so messages moving into or out of the inbox between pages cannot shift an
  offset and skip older mail.
- Newly issued IMAP message IDs carry the same fingerprint and are rejected if
  fetched after the account is repointed. Legacy bare and UIDVALIDITY-only IDs
  remain readable for compatibility.
- Page commits also require the account's captured inbound generation and enabled
  state, so disabling or changing its inbound endpoint, identity, capability, or
  credentials during provider I/O rolls the page back instead of publishing
  stale-mailbox events. Cosmetic and SMTP-only edits preserve that generation.
- Poll state is bound to that generation for every provider. Repointing AgentMail,
  Resend, OAuth, or IMAP accounts clears any old cursor/seen boundary and requires
  a replacement silent baseline.
- Account configuration and encrypted credential changes commit in one database
  transaction, so provider snapshots cannot observe a new endpoint with old
  credentials (or the inverse).
- Events contain routing metadata (`accountId`, provider/message/thread IDs,
  addresses, subject, timestamps). Bodies and snippets remain provider-side and
  must be fetched through the scoped operational API or MCP tool.
- `INBOUND_POLL_INTERVAL_SECONDS=0` disables background polling. The authenticated
  manual poll endpoint remains available for operations and tests.

## Anti-loop guard

- `MAX_SENDS_PER_ACCOUNT_PER_HOUR` (default `60`) prevents excessive outbound sends per account/profile.

## Non-goals (MVP)

- No attachment end-to-end operations
- No mailbox replication or local index
- No campaign/automation execution; consumers such as `slab-agents` own dispatch
- No webmail UI
