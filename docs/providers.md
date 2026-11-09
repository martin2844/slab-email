# Email providers

All providers use the same account, access-profile, token, policy, REST, and MCP
model. Provider credentials are encrypted by `slab-email`; agents receive only a
scoped connector token.

| Provider | Read/search | Draft | Send | Reply | Threads |
| --- | --- | --- | --- | --- | --- |
| Gmail | Yes | Yes | Yes | Yes | Yes |
| Microsoft Graph | Yes | Yes | Yes | Yes | Yes |
| Proton Bridge | Yes | No | Yes | Yes | No |
| Generic IMAP/SMTP | Yes | No | Yes | Yes | No |
| AgentMail | Yes | Yes | Yes | Yes | Yes |
| Resend (inbound enabled) | Yes | No | Yes | No | No |
| Resend (send-only) | No | No | Yes | No | No |

## HTML bodies and attachments

`text` is always required; when `html` is provided it is sent as the HTML
alternative. Outgoing attachments are validated centrally (default max 10 files,
10 MB decoded total, no path separators/control characters in filenames).

| Provider | HTML send/reply/draft | Outgoing attachments | Incoming attachment metadata + download |
| --- | --- | --- | --- |
| Proton Bridge / Generic IMAP/SMTP | multipart/alternative (no drafts) | MIME multipart/mixed | Yes (id = MIME order of the parsed message) |
| Gmail | multipart/alternative | MIME; messages > 3 MB use the RFC 822 media upload | Yes (id = MIME partId) |
| Microsoft Graph | HTML body (see note) | Inline file attachments up to 2.5 MB total; larger via draft + upload sessions | File attachments only (item/reference attachments return `NOT_SUPPORTED`) |
| AgentMail | `html` field | `attachments` (base64) on send, reply, draft | Yes (bytes or pre-signed `download_url`) |
| Resend | `html` field (send only) | `attachments` (base64) on send | Yes for inbound-enabled accounts (pre-signed `download_url`) |

Notes:

- Microsoft Graph replies: plain-text replies keep using `comment` (original
  message quoted by Exchange). With `html`, Graph only accepts a full
  `message.body`, so the HTML replaces the body and the original is not quoted.
- Microsoft Graph only lists attachments when `hasAttachments` is true, so
  messages that carry nothing but inline images report no attachments.
- Bcc is never written into SMTP message headers; Gmail receives it in the raw
  source as its API requires and strips it on delivery.

## Generic IMAP/SMTP

Use an app-specific password where the mail provider supports one. Configure
IMAP and SMTP host, port, and TLS mode explicitly. This adapter works with
Fastmail, Zoho, Yahoo, iCloud, self-hosted mail, and other standard providers.

## Microsoft 365 / Outlook

Register a Microsoft identity-platform Web application. Add the exact callback
shown by Slab Agents and grant delegated `Mail.ReadWrite`, `Mail.Send`,
`offline_access`, `openid`, `profile`, and `email` scopes. `common` allows both
personal Microsoft accounts and organizational accounts; use a tenant ID when
the app must remain organization-specific.

## AgentMail

Create or select an AgentMail inbox, then enter its inbox ID and an API key.
Prefer an inbox-scoped AgentMail key when possible. AgentMail is appropriate
when the mailbox itself belongs to an agent rather than a human operator.

## Resend

Enter a verified sender address and Resend API key. Enable inbound reading only
after configuring a receiving domain/address in Resend. The adapter uses the
Receiving API for messages and the Email API for sends. Resend does not provide
mailbox drafts or conversation threads, so those capabilities remain disabled.

## Nylas and other aggregators

Nylas can be useful when a deployment prefers one third-party authorization and
mailbox abstraction across many providers. It is not a native adapter in this
release because that would duplicate the provider abstraction already owned by
`slab-email`. Connect a suitable Nylas API or MCP surface through Slab Agents'
Custom Integrations when that trade-off is intentional.
