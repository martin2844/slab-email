# slab-agents integration contract

`slab-email` integrates as a headless connector through REST + MCP.

## Current integration readiness

This repository contains the connector contract and runtime behavior required by `slab-agents`.
If `slab-agents` is available locally, use this contract to implement the settings UI and runbook.

## 1) Service registration

From `slab-agents`, configure connector endpoint:

- Name: `slab-email`
- URL: `http://127.0.0.1:6981` (local default)
- Health check: `GET /health`
- MCP URL: `http://127.0.0.1:6981/mcp`

## 2) Admin setup from `slab-agents`

`slab-agents` backend should use admin endpoints with `SLAB_EMAIL_ADMIN_KEY`:

- Create/list/delete accounts.
- Create/list/patch access profiles.
- Create connector tokens (`POST /api/access-profiles/:id/tokens`).
- Save token metadata (`id`, `prefix`, createdAt) only.

Never persist raw connector token where it can be exposed to UI.

## 3) Agent run config

For each agent run, choose:

- A connector profile by name.
- Required capabilities:
  - read
  - draft
  - send
- Map UI `send policy` to agent run behavior:
  - `approval required` (default, recommended for safety)
  - `disabled`
  - `autonomous`

`slab-email` enforces capabilities only; approval policy is external to this service.

## 4) Scoped token flow

1. On connector assignment, call `slab-email` profile/token endpoints.
2. Use token + profile constraints in agent MCP session.
3. `slab-email` will expose only:
   - allowed accounts
   - operations matching profile flags

## 4a) Inbound automation feed

`slab-agents` consumes `GET /api/inbound/events?after=<cursor>` with the admin
credential over the private service network. It must persist its cursor and
deduplicate dispatches by `(automationId, eventId)` before advancing the cursor.

The event is a notification, not an email-body copy. A dispatched agent reads the
message through its scoped email tools using the supplied account and message IDs.
The first complete account scan is baseline-only, so connecting an existing
mailbox does not trigger historical automation runs. Large baselines resume over
multiple bounded polls and remain silent until completion.

## 5) UI behavior contract (for agents UI)

### Settings → Integrations → Email

- Show:
  - service URL
  - status
- Test connection button using admin key or server health.

### Connected accounts section

Display account list and actions:

- connected email
- provider (`proton_bridge`, `imap_smtp`, `gmail`)
- enable/disable/remove buttons

No secrets are ever shown.

### Gmail connect UX

- Button opens admin endpoint `/api/accounts/gmail/connect` on backend.
- Backend obtains authorization URL and redirects/open in browser.

### Agent capabilities assignment

Selecting an access profile returns:

- account IDs
- operations enabled (`read`, `draft`, `send`)
- `send policy`

At run-time, pass connector token to MCP endpoint only.

## 6) Why this is safe for agents

- No main SMTP account password stored in UI.
- No connector secrets passed through UI state.
- No attachment download/upload in MVP.
- Metadata-only inbound discovery runs in the background; message bodies remain
  provider-side and are never persisted in the event feed.
