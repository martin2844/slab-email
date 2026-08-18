import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import { createFakeProvider } from './fakes.js';
import { createProfileAndToken, createTestContext } from './helpers.js';

describe('search/get payload shape', () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('does not return full body in search and returns body in get', async () => {
    const account = await request(ctx.app)
      .post('/api/accounts/imap-smtp')
      .set('Authorization', `Bearer ${ctx.config.adminKey}`)
      .send({
        emailAddress: 'support@clasific.ar',
        displayName: 'Support',
        imapHost: '127.0.0.1',
        imapPort: 1143,
        imapTlsMode: 'ssl',
        smtpHost: '127.0.0.1',
        smtpPort: 1025,
        smtpTlsMode: 'starttls',
        username: 'support',
        password: 'secret'
      })
      .expect(201);

    const fakeProvider = createFakeProvider({
      searchResult: [
        {
          id: 'search-id-1',
          accountId: '',
          from: { address: 'from@x.com' },
          to: [{ address: 'to@x.com' }],
          subject: 'Invoice',
          date: new Date().toISOString(),
          snippet: 'Short snippet',
          threadId: 'thread-1',
          unread: true
        }
      ],
      getMessageResult: {
        id: 'search-id-1',
        accountId: account.body.id,
        provider: 'imap_smtp',
        from: { address: 'from@x.com' },
        to: [{ address: 'to@x.com' }],
        cc: [],
        bcc: [],
        subject: 'Invoice',
        date: new Date().toISOString(),
        text: 'full message body',
        html: '<p>full message body</p>',
        snippet: 'full snippet'
      }
    });

    vi.spyOn(ctx.accountService, 'getProviderForAccount').mockResolvedValue(fakeProvider as never);

    const { token } = await createProfileAndToken(ctx, account.body.id, {
      readEnabled: true,
      sendEnabled: false,
      draftEnabled: false
    });

    const searchRes = await request(ctx.app)
      .get('/api/mail/search')
      .query({ accountId: account.body.id, limit: 2 })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(searchRes.body.items).toHaveLength(1);
    expect(searchRes.body.items[0]).toMatchObject({
      id: 'search-id-1',
      threadId: 'thread-1',
      subject: 'Invoice'
    });
    expect(searchRes.body.items[0]).not.toHaveProperty('text');
    expect(searchRes.body.items[0]).not.toHaveProperty('html');

    const messageRes = await request(ctx.app)
      .get(`/api/mail/messages/${account.body.id}/search-id-1`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(messageRes.body).toMatchObject({
      id: 'search-id-1',
      text: 'full message body',
      html: '<p>full message body</p>'
    });
  });
});
