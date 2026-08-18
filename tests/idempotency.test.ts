import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import { createFakeProvider } from './fakes.js';
import { createProfileAndToken, createTestContext } from './helpers.js';

describe('send idempotency', () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  const createAccount = async () =>
    request(ctx.app)
      .post('/api/accounts/proton-bridge')
      .set('Authorization', `Bearer ${ctx.config.adminKey}`)
      .send({
        emailAddress: 'ops@clasific.ar',
        displayName: 'Ops',
        imapHost: '127.0.0.1',
        imapPort: 1143,
        imapTlsMode: 'ssl',
        smtpHost: '127.0.0.1',
        smtpPort: 1025,
        smtpTlsMode: 'starttls',
        username: 'ops',
        password: 'secret'
      });

  it('reuses successful send result with same idempotency key', async () => {
    const account = await createAccount();
    const fakeProvider = createFakeProvider({
      sendResult: { status: 'sent', providerMessageId: 'msg-abc', providerThreadId: 'thread-a' }
    });

    const sendSpy = vi.spyOn(fakeProvider, 'sendMessage');
    vi.spyOn(ctx.accountService, 'getProviderForAccount').mockResolvedValue(fakeProvider as never);

    const { token } = await createProfileAndToken(ctx, account.body.id, {
      readEnabled: true,
      sendEnabled: true,
      draftEnabled: true
    });

    const first = await request(ctx.app)
      .post('/api/mail/send')
      .set('Authorization', `Bearer ${token}`)
      .send({
        accountId: account.body.id,
        to: ['person@company.com'],
        subject: 'Hola',
        text: 'cuerpo',
        idempotencyKey: 'fixed-key'
      })
      .expect(200);

    expect(first.body.status).toBe('sent');
    expect(first.body.providerMessageId).toBe('msg-abc');

    const second = await request(ctx.app)
      .post('/api/mail/send')
      .set('Authorization', `Bearer ${token}`)
      .send({
        accountId: account.body.id,
        to: ['person@company.com'],
        subject: 'Hola',
        text: 'cuerpo',
        idempotencyKey: 'fixed-key'
      })
      .expect(200);

    expect(second.body.status).toBe('sent');
    expect(second.body.providerMessageId).toBe('msg-abc');
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('returns unknown state when outcome is ambiguous and blocks retry', async () => {
    const account = await createAccount();
    const fakeProvider = createFakeProvider({
      sendResult: { status: 'unknown', providerMessageId: 'msg-unknown' }
    });

    vi.spyOn(fakeProvider, 'sendMessage');
    vi.spyOn(ctx.accountService, 'getProviderForAccount').mockResolvedValue(fakeProvider as never);

    const { token } = await createProfileAndToken(ctx, account.body.id, {
      readEnabled: true,
      sendEnabled: true,
      draftEnabled: true
    });

    const first = await request(ctx.app)
      .post('/api/mail/send')
      .set('Authorization', `Bearer ${token}`)
      .send({
        accountId: account.body.id,
        to: ['person@company.com'],
        subject: 'Unknown',
        text: 'body',
        idempotencyKey: 'unknown-key'
      })
      .expect(424);

    expect(first.body.error.code).toBe('SEND_OUTCOME_UNKNOWN');

    const second = await request(ctx.app)
      .post('/api/mail/send')
      .set('Authorization', `Bearer ${token}`)
      .send({
        accountId: account.body.id,
        to: ['person@company.com'],
        subject: 'Unknown',
        text: 'body',
        idempotencyKey: 'unknown-key'
      })
      .expect(424);

    expect(second.body.error.code).toBe('SEND_OUTCOME_UNKNOWN');
    expect(fakeProvider.sendMessage).toHaveBeenCalledTimes(1);
  });
});
