# Gmail setup

`slab-email` uses OAuth2 + Gmail API.

## OAuth credentials

Required Google credentials:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI` (default `http://127.0.0.1:6981/api/oauth/google/callback`)

Scopes used by default:

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.compose`
- `https://www.googleapis.com/auth/gmail.send`

## Connect flow

1. Ensure env vars are set.
2. Start service.
3. Call:

`POST /api/accounts/gmail/connect`

Body:

```json
{
  "returnUrl": "http://127.0.0.1:6981/agents"
}
```

4. Open returned `authorizationUrl` in browser.
5. Approve permissions.
6. Google redirects to:

`/api/oauth/google/callback?code=...&state=...`

7. Service stores Gmail account + encrypted refresh token.

## What is stored

Only config and encrypted token payload (`refreshToken`) are persisted.
Account email and display name are fetched from Google profile.

## Notes

- We do not use webmail scraping.
- Refresh token never leaves `slab-email` except as part of encrypted DB payload.
- If `refreshToken` is not returned by Google, connect fails.
