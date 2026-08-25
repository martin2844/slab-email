# Managed Proton Bridge

`slab-email` can supervise the official Proton Mail Bridge headless backend in
the same container. It is a provider lifecycle inside the email connector, not
a separate network service.

## Security boundary

- Proton login passwords, TOTP codes, mailbox passwords, and human-verification
  responses are accepted only by admin-authenticated endpoints.
- Login values are sent to Bridge over private stdin/PTY pipes. They are never
  stored, logged, returned by the API, or exposed through MCP.
- Bridge's generated IMAP/SMTP password is stored using the existing encrypted
  account-secret store.
- Bridge state, its GPG keychain, and its `pass` store live under the existing
  `/data` volume with private permissions.
- The Bridge CLI output is not forwarded into application logs or API results.

## Lifecycle

`GET /api/proton-bridge` reports availability and managed accounts. Connect a
new account with `POST /api/proton-bridge/connect`; continue TOTP, mailbox
password, or human-verification challenges with
`POST /api/proton-bridge/challenge`. Abort an unfinished setup with
`POST /api/proton-bridge/abort`. Deleting through
`DELETE /api/proton-bridge/accounts/:id` signs the account out of Bridge and
removes its encrypted mailbox record.

`POST /api/proton-bridge/accounts/:id/sync-addresses` changes a connected
account to Bridge split-address mode when necessary and imports every verified
Proton/custom-domain address as a separate managed mailbox. Each imported
mailbox has its own Bridge-generated IMAP/SMTP credentials and can therefore be
assigned independently to an agent. Removing an imported alias removes only
that local mailbox; removing the primary login signs out the Proton account and
removes all of its managed aliases.

Sync also reconciles addresses removed from Proton and refreshes credentials
for addresses that remain active. Unassigned stale aliases are removed locally.
If a stale alias is still assigned to an access profile, its local record is
disabled and sync reports `ACCOUNT_IN_USE` until the assignment is removed.
Deleting a primary login is likewise rejected while any sender in that Proton
group is assigned. If an assignment appears while Bridge is signing out, local
records and assignments are preserved and the operation reports a recoverable
conflict instead of cascading them away.

Agentic sends must include `expectedFrom` from the latest
`email_list_accounts` result. The connector rejects a send if that address does
not match the selected mailbox, so an agent prompt or message signature cannot
silently substitute a different SMTP sender.

Agentic replies additionally require the exact original sender and derived
reply subject from the latest message read. MCP replies are plain text,
single-recipient operations; reply-all, HTML, and CC remain available only to
trusted REST callers and are not exposed as approvable agent actions.

The official source is downloaded from Proton's pinned GitHub release during
the image build and verified with a fixed SHA-256 checksum. Bridge is compiled
with a compatible patched Go toolchain. Its GPLv3 license is
included at `/usr/local/libexec/PROTON-BRIDGE-LICENSE` in the image, and the
exact v3.26.0 corresponding source archive is included at
`/usr/local/libexec/PROTON-BRIDGE-SOURCE.tar.gz`.

## Limitations

- Managed Bridge is built for amd64 and arm64 with a compatible patched Go
  toolchain. Other architectures can use an externally managed Bridge or a
  standard IMAP/SMTP account.
- Proton Bridge requires a paid Proton plan.
- FIDO-only interactive login is not automated. TOTP and Proton human
  verification are supported.
