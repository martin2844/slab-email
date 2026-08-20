import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import { createTestContext } from './helpers.js';

describe('OAuth security and validation', () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('rejects invalid OAuth state', async () => {
    const res = await request(ctx.app)
      .get('/api/oauth/google/callback')
      .query({ state: 'bad-state', code: 'code-1' })
      .expect(400);

    expect(res.body.error.code).toBe('STATE_INVALID');
  });

  it('rejects expired OAuth state', async () => {
    const accountState = {
      state: 'expired-state',
      provider: 'gmail',
      requestedAt: Date.now() - 20 * 60 * 1000,
      expiresAt: Date.now() - 10 * 60 * 1000,
      codeVerifier: 'verifier',
      code_verifier: 'verifier',
      meta: { provider: 'gmail', returnUrl: '/agents' }
    };

    ctx.db.createOauthState({
      state: accountState.state,
      provider: accountState.provider,
      requestedAt: accountState.requestedAt,
      expiresAt: accountState.expiresAt,
      codeVerifier: 'verifier',
      meta: accountState.meta
    });

    const res = await request(ctx.app)
      .get('/api/oauth/google/callback')
      .query({ state: accountState.state, code: 'code-1' })
      .expect(400);

    expect(res.body.error.code).toBe('STATE_EXPIRED');
  });

  it('requires Google OAuth credentials on connect endpoint', async () => {
    const ctxWithoutGoogle = createTestContext({
      googleClientId: '',
      googleClientSecret: ''
    });

    const res = await request(ctxWithoutGoogle.app)
      .post('/api/accounts/gmail/connect')
      .set('Authorization', `Bearer ${ctxWithoutGoogle.config.adminKey}`)
      .send({ returnUrl: 'http://127.0.0.1:6981/ok' })
      .expect(400);

    expect(res.body.error.code).toBe('INVALID_CONFIGURATION');
    ctxWithoutGoogle.cleanup();
  });

  it('uses the requested control-plane callback throughout the OAuth flow', async () => {
    const callback = 'http://127.0.0.1:3009/api/integrations/email/google/callback';
    const response = await request(ctx.app)
      .post('/api/accounts/gmail/connect')
      .set('Authorization', `Bearer ${ctx.config.adminKey}`)
      .send({ returnUrl: callback })
      .expect(200);

    const authorizationUrl = new URL(response.body.authorizationUrl);
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(callback);
  });
});
