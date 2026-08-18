import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import { createFakeProvider } from './fakes.js';
import { createProfileAndToken, createTestContext } from './helpers.js';

describe('access profile scoping', () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
    const fakeProvider = createFakeProvider({
      searchResult: [
        {
          id: '1',
          accountId: '',
          from: { address: 'from@example.com' },
          to: [{ address: 'to@example.com' }],
          subject: 'hello',
          date: new Date().toISOString(),
          snippet: 'snippet',
          threadId: null
        }
      ]
    });

    vi.spyOn(ctx.accountService, 'getProviderForAccount').mockImplementation(async () => fakeProvider as never);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  const basePayload = {
    emailAddress: 'sales@clasific.ar',
    displayName: 'Sales',
    imapHost: '127.0.0.1',
    imapPort: 1143,
    imapTlsMode: 'ssl' as const,
    smtpHost: '127.0.0.1',
    smtpPort: 1025,
    smtpTlsMode: 'starttls' as const,
    username: 'sales',
    password: 'secret'
  };

  it('restricts list and read operations to accounts in profile', async () => {
    const first = await request(ctx.app)
      .post('/api/accounts/proton-bridge')
      .set('Authorization', `Bearer ${ctx.config.adminKey}`)
      .send(basePayload)
      .expect(201);

    const second = await request(ctx.app)
      .post('/api/accounts/proton-bridge')
      .set('Authorization', `Bearer ${ctx.config.adminKey}`)
      .send({ ...basePayload, emailAddress: 'finance@clasific.ar', displayName: 'Finance', username: 'finance' })
      .expect(201);

    const { token } = await createProfileAndToken(ctx, first.body.id, { readEnabled: true, sendEnabled: false, draftEnabled: false });

    const accountList = await request(ctx.app)
      .get('/api/accounts')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(accountList.body).toHaveLength(1);
    expect(accountList.body[0].id).toBe(first.body.id);

    const unauthorizedSearch = await request(ctx.app)
      .get('/api/mail/search')
      .query({ accountId: second.body.id, limit: 5 })
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    expect(unauthorizedSearch.body.error.code).toBe('PERMISSION_DENIED');

    const allowedSearch = await request(ctx.app)
      .get('/api/mail/search')
      .query({ accountId: first.body.id, limit: 5 })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(allowedSearch.body.items).toHaveLength(1);
    expect(allowedSearch.body.items[0].id).toBe('1');
  });
});
