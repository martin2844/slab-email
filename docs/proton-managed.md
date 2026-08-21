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

The official binary is downloaded from Proton's pinned GitHub release during
the image build and verified with a fixed SHA-256 checksum. Its GPLv3 license is
included at `/usr/local/libexec/PROTON-BRIDGE-LICENSE` in the image. The exact
v3.26.0 corresponding source archive is included at
`/usr/local/libexec/PROTON-BRIDGE-SOURCE.tar.gz`.

## Limitations

- Managed Bridge is available on amd64 only because Proton publishes an amd64
  Linux package. Other architectures can use an externally managed Bridge or a
  standard IMAP/SMTP account.
- Proton Bridge requires a paid Proton plan.
- FIDO-only interactive login is not automated. TOTP and Proton human
  verification are supported.
