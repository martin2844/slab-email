import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import { createFakeProvider } from './fakes.js';
import { createProfileAndToken, createTestContext } from './helpers.js';

describe('permission boundaries', () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
    vi.spyOn(ctx.accountService, 'getProviderForAccount').mockResolvedValue(createFakeProvider({}) as never);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('prevents send when profile sendEnabled is false', async () => {
    const account = await request(ctx.app)
      .post('/api/accounts/proton-bridge')
      .set('Authorization', `Bearer ${ctx.config.adminKey}`)
      .send({
        emailAddress: 'read-only@clasific.ar',
        displayName: 'RO',
        imapHost: '127.0.0.1',
        imapPort: 1143,
        imapTlsMode: 'ssl',
        smtpHost: '127.0.0.1',
        smtpPort: 1025,
        smtpTlsMode: 'starttls',
        username: 'readonly',
        password: 'secret'
      })
      .expect(201);

    const { token } = await createProfileAndToken(ctx, account.body.id, {
      readEnabled: true,
      draftEnabled: false,
      sendEnabled: false
    });

    const res = await request(ctx.app)
      .post('/api/mail/send')
      .set('Authorization', `Bearer ${token}`)
      .send({
        accountId: account.body.id,
        to: ['person@company.com'],
        subject: 'Test',
        text: 'body',
        idempotencyKey: 'k-1'
      })
      .expect(403);

    expect(res.body.error.code).toBe('PERMISSION_DENIED');

    const draftRes = await request(ctx.app)
      .post('/api/mail/drafts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        accountId: account.body.id,
        to: ['person@company.com'],
        subject: 'Draft',
        text: 'body'
      });

    expect(draftRes.status).toBe(403);
    expect(draftRes.body.error.code).toBe('PERMISSION_DENIED');
  });
});
