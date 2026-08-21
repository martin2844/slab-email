import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import { createTestContext } from './helpers.js';

describe('OAuth security and validation', () => {
  it('reports environment OAuth configuration without returning its secret', async () => {
    const response = await request(ctx.app)
      .get('/api/settings/google-oauth')
      .set('Authorization', `Bearer ${ctx.config.adminKey}`)
      .expect(200);

    expect(response.body).toEqual({
      configured: true,
      clientId: 'test-google-client-id',
      hasClientSecret: true,
      source: 'environment',
      updatedAt: null
    });
    expect(JSON.stringify(response.body)).not.toContain('test-google-client-secret');
  });

  it('protects OAuth settings with administrator authentication', async () => {
    await request(ctx.app).get('/api/settings/google-oauth').expect(401);
    await request(ctx.app)
      .patch('/api/settings/google-oauth')
      .send({ clientId: 'unauthorized', clientSecret: 'must-not-store' })
      .expect(401);
  });

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

  it('stores Google OAuth credentials encrypted and never returns the client secret', async () => {
    const ctxWithoutGoogle = createTestContext({
      googleClientId: '',
      googleClientSecret: ''
    });
    const clientSecret = 'google-client-secret-that-must-not-leak';

    const initial = await request(ctxWithoutGoogle.app)
      .get('/api/settings/google-oauth')
      .set('Authorization', `Bearer ${ctxWithoutGoogle.config.adminKey}`)
      .expect(200);
    expect(initial.body).toEqual({
      configured: false,
      clientId: '',
      hasClientSecret: false,
      source: 'missing',
      updatedAt: null
    });

    const configured = await request(ctxWithoutGoogle.app)
      .patch('/api/settings/google-oauth')
      .set('Authorization', `Bearer ${ctxWithoutGoogle.config.adminKey}`)
      .send({ clientId: 'configured-client-id', clientSecret })
      .expect(200);
    expect(configured.body.configured).toBe(true);
    expect(configured.body.clientId).toBe('configured-client-id');
    expect(configured.body.hasClientSecret).toBe(true);
    expect(configured.body.source).toBe('stored');
    expect(JSON.stringify(configured.body)).not.toContain(clientSecret);

    const stored = ctxWithoutGoogle.db.getProviderCredentials('google_oauth');
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(clientSecret);

    const connect = await request(ctxWithoutGoogle.app)
      .post('/api/accounts/gmail/connect')
      .set('Authorization', `Bearer ${ctxWithoutGoogle.config.adminKey}`)
      .send({ returnUrl: 'http://127.0.0.1:6981/ok' })
      .expect(200);
    const authorizationUrl = new URL(connect.body.authorizationUrl);
    expect(authorizationUrl.searchParams.get('client_id')).toBe('configured-client-id');

    const updated = await request(ctxWithoutGoogle.app)
      .patch('/api/settings/google-oauth')
      .set('Authorization', `Bearer ${ctxWithoutGoogle.config.adminKey}`)
      .send({ clientId: 'renamed-client-id' })
      .expect(200);
    expect(updated.body.clientId).toBe('renamed-client-id');
    expect(JSON.stringify(updated.body)).not.toContain(clientSecret);
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

  it('stores Microsoft OAuth credentials and builds a PKCE authorization URL', async () => {
    const clientSecret = 'microsoft-client-secret-that-must-not-leak';
    const configured = await request(ctx.app)
      .patch('/api/settings/microsoft-oauth')
      .set('Authorization', `Bearer ${ctx.config.adminKey}`)
      .send({ clientId: 'microsoft-app-id', clientSecret, tenant: 'common' })
      .expect(200);
    expect(configured.body).toMatchObject({
      configured: true,
      clientId: 'microsoft-app-id',
      tenant: 'common',
      source: 'stored',
    });
    expect(configured.text).not.toContain(clientSecret);

    const callback = 'http://127.0.0.1:3009/api/integrations/email/microsoft/callback';
    const connect = await request(ctx.app)
      .post('/api/accounts/microsoft/connect')
      .set('Authorization', `Bearer ${ctx.config.adminKey}`)
      .send({ returnUrl: callback })
      .expect(200);
    const authorizationUrl = new URL(connect.body.authorizationUrl);
    expect(authorizationUrl.hostname).toBe('login.microsoftonline.com');
    expect(authorizationUrl.searchParams.get('client_id')).toBe('microsoft-app-id');
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(callback);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
  });
});
