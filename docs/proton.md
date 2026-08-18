# Proton Mail Bridge setup

`slab-email` connects to Proton through **Proton Mail Bridge**, not to Proton webmail directly.

This means:

- Bridge credentials are required.
- No Proton account password is ever stored by `slab-email`.
- IMAP/SMTP host/port details come from your Bridge config.

## Steps

1. Install and log in to **Proton Mail Bridge**.
2. Create/select account in Bridge.
3. Open Bridge connection settings:
   - IMAP host + port
   - SMTP host + port
   - Security mode per endpoint.
4. In `slab-email`, call:

`POST /api/accounts/proton-bridge`

Example payload:

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
  "username": "bridge-username",
  "password": "bridge-password"
}
```

5. Test:
   `POST /api/accounts/:id/test`
6. Keep these in mind:
   - Bridge credentials are credentials for Bridge sessions, not your Proton account password.
   - If using local cert overrides, enable carefully only for loopback hosts.
   - Prefer custom CA paths over globally disabling TLS.

## Notes

- `slab-email` does not ship or manage Bridge itself.
- For Docker usage, Bridge is usually local to host; container networking may require host networking.
