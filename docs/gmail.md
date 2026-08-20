# Gmail setup

`slab-email` uses OAuth2 + Gmail API.

## OAuth credentials

Required Google credentials can be supplied either through the admin API or at
process startup:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI` (default `http://127.0.0.1:6981/api/oauth/google/callback`)

For a managed Slab installation, configure the OAuth client from Slab Agents
Settings. Slab Agents sends the values once to the authenticated server-side
admin API. `slab-email` encrypts the client secret with
`SLAB_EMAIL_MASTER_KEY`; GET responses expose only `hasClientSecret` and never
return the secret. Environment credentials remain a deployment fallback.

Scopes used by default:

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.compose`
- `https://www.googleapis.com/auth/gmail.send`

## Connect flow

1. Configure the OAuth client through Slab Agents, or ensure the environment
   credentials are set before starting the service.
2. Add the exact Slab Agents callback shown in Settings to the Google Cloud
   OAuth client's authorized redirect URIs.
3. Call:

`POST /api/accounts/gmail/connect`

Body:

```json
{
  "returnUrl": "http://127.0.0.1:3009/api/integrations/email/google/callback"
}
```

4. Open returned `authorizationUrl` in browser.
5. Approve permissions.
6. Google redirects to the supplied `returnUrl`. A control plane can proxy the
   `code` and `state` to:

`/api/oauth/google/callback?code=...&state=...`

7. Service stores Gmail account + encrypted refresh token.

## What is stored

The OAuth client ID and encrypted client secret are stored in the service DB
when configured through the admin API. Gmail account config and encrypted token
payload (`refreshToken`) are persisted separately.
Account email and display name are fetched from Google profile.

## Notes

- We do not use webmail scraping.
- Refresh token never leaves `slab-email` except as part of encrypted DB payload.
- If `refreshToken` is not returned by Google, connect fails.
