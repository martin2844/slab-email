import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import { createFakeProvider } from './fakes.js';
import { createProfileAndToken, createTestContext } from './helpers.js';
import type { RuntimeConfig } from '../src/config/env.js';

const parseMcp = (body: string) => {
  const line = body.split('\n').reverse().find((entry) => entry.startsWith('data: '));
  return line ? JSON.parse(line.slice(6)) : {};
};

describe('outreach safety, html and attachments', () => {
  let ctx: ReturnType<typeof createTestContext>;

  afterEach(() => {
    vi.useRealTimers();
    ctx?.cleanup();
  });

  const setup = async (overrides: Partial<RuntimeConfig> = {}) => {
    ctx = createTestContext(overrides);
    const account = await request(ctx.app)
      .post('/api/accounts/proton-bridge')
      .set('Authorization', `Bearer ${ctx.config.adminKey}`)
      .send({
        emailAddress: 'sales@clasific.ar',
        displayName: 'Sales',
        imapHost: '127.0.0.1',
        imapPort: 1143,
        imapTlsMode: 'ssl',
        smtpHost: '127.0.0.1',
        smtpPort: 1025,
        smtpTlsMode: 'starttls',
        username: 'sales',
        password: 'secret'
      })
      .expect(201);
    const provider = createFakeProvider();
    vi.spyOn(ctx.accountService, 'getProviderForAccount').mockResolvedValue(provider as never);
    const { token } = await createProfileAndToken(ctx, account.body.id, {
      readEnabled: true,
      draftEnabled: true,
      sendEnabled: true
    });
    const accountId = account.body.id as string;
    const send = (body: Record<string, unknown>) =>
      request(ctx.app)
        .post('/api/mail/send')
        .set('Authorization', `Bearer ${token}`)
        .send({ accountId, subject: 'Hola', text: 'cuerpo', ...body });
    const reply = (body: Record<string, unknown>) =>
      request(ctx.app)
        .post('/api/mail/reply')
        .set('Authorization', `Bearer ${token}`)
        .send({ accountId, messageId: 'message-1', text: 'gracias', ...body });
    const mcp = async (name: string, args: Record<string, unknown>) =>
      parseMcp(
        (
          await request(ctx.app)
            .post('/mcp')
            .set('Authorization', `Bearer ${token}`)
            .set('Accept', 'application/json, text/event-stream')
            .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
            .expect(200)
        ).text
      );
    const admin = () => ({ Authorization: `Bearer ${ctx.config.adminKey}` });
    return { accountId, token, provider, send, reply, mcp, admin };
  };

  describe('suppression list', () => {
    it('refuses email_send to any suppressed to/cc/bcc recipient without sending anything', async () => {
      const { provider, send, admin } = await setup();
      await request(ctx.app)
        .post('/api/suppressions')
        .set(admin())
        .send({ address: 'Opted.Out@Example.com', reason: 'replied: unsubscribe' })
        .expect(201);
      await request(ctx.app)
        .post('/api/suppressions')
        .set(admin())
        .send({ domain: 'blocked.io', reason: 'company asked us to stop' })
        .expect(201);

      for (const [field, address] of [
        ['to', 'opted.out@example.com'],
        ['cc', 'OPTED.OUT@example.com'],
        ['bcc', 'opted.out@example.com'],
        ['to', 'ceo@blocked.io'],
        ['to', 'someone@eu.blocked.io']
      ] as const) {
        const body: Record<string, unknown> = { to: ['fine@example.com'], idempotencyKey: `k-${field}-${address}` };
        body[field] = field === 'to' ? ['fine@example.com', address] : [address];
        const response = await send(body).expect(409);
        expect(response.body.error.code).toBe('RECIPIENT_SUPPRESSED');
        expect(response.body.error.message).toMatch(/Nothing was sent/);
        expect(response.body.error.details.suppressed[0].address).toBe(address.toLowerCase());
      }
      expect(provider.sendMessage).not.toHaveBeenCalled();

      // A refused key is not consumed: once the recipient is removed it can be retried.
      await send({ to: ['fine@example.com', 'notblocked.io@example.com'], idempotencyKey: 'ok-1' }).expect(200);
      expect(provider.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('allows replies to a suppressed sender but refuses suppressed cc additions', async () => {
      const { provider, reply, admin } = await setup();
      await request(ctx.app).post('/api/suppressions').set(admin()).send({ address: 'from@example.com', reason: 'stop' }).expect(201);
      await request(ctx.app).post('/api/suppressions').set(admin()).send({ address: 'boss@example.com', reason: 'stop' }).expect(201);

      await reply({ to: ['from@example.com'], idempotencyKey: 'r1' }).expect(200);
      expect(provider.replyToMessage).toHaveBeenCalledTimes(1);

      const refused = await reply({ to: ['from@example.com'], cc: ['boss@example.com'], idempotencyKey: 'r2' }).expect(409);
      expect(refused.body.error.code).toBe('RECIPIENT_SUPPRESSED');
      expect(provider.replyToMessage).toHaveBeenCalledTimes(1);
    });

    it('records opt-outs through MCP email_suppress and connector REST, and admins can list/remove', async () => {
      const { mcp, token, send, admin } = await setup();
      const result = await mcp('email_suppress', { address: 'Lead@Example.com', reason: 'no me escriban' });
      expect(result.result.isError).toBeFalsy();
      expect(result.result.structuredContent).toMatchObject({
        suppressed: true,
        created: true,
        entry: { kind: 'address', value: 'lead@example.com' }
      });
      const again = await mcp('email_suppress', { address: 'lead@example.com', reason: 'stop' });
      expect(again.result.structuredContent).toMatchObject({ created: false });

      const domain = await mcp('email_suppress', { address: 'ops@acme.test', reason: 'unsubscribe all', scope: 'domain' });
      expect(domain.result.structuredContent.entry).toMatchObject({ kind: 'domain', value: 'acme.test' });

      await request(ctx.app)
        .post('/api/mail/suppressions')
        .set('Authorization', `Bearer ${token}`)
        .send({ address: 'other@example.com', reason: 'stop' })
        .expect(201);
      // Connector tokens cannot list or remove entries.
      await request(ctx.app).get('/api/suppressions').set('Authorization', `Bearer ${token}`).expect(401);

      const list = await request(ctx.app).get('/api/suppressions').set(admin()).expect(200);
      expect(list.body.items.map((entry: { value: string }) => entry.value).sort()).toEqual([
        'acme.test',
        'lead@example.com',
        'other@example.com'
      ]);
      const leadEntry = list.body.items.find((entry: { value: string }) => entry.value === 'lead@example.com');
      expect(leadEntry).toMatchObject({ reason: 'no me escriban', source: 'connector' });
      const filtered = await request(ctx.app).get('/api/suppressions?q=acme').set(admin()).expect(200);
      expect(filtered.body.items).toHaveLength(1);

      const refused = await mcp('email_send', {
        accountId: (await request(ctx.app).get('/api/accounts').set(admin())).body[0].id,
        expectedFrom: 'sales@clasific.ar',
        to: ['lead@example.com'],
        subject: 'Hola',
        text: 'cuerpo',
        idempotencyKey: 'mcp-1'
      });
      expect(refused.result.isError).toBe(true);
      expect(refused.result.structuredContent).toMatchObject({
        code: 'RECIPIENT_SUPPRESSED',
        details: { suppressed: [{ address: 'lead@example.com', kind: 'address' }] }
      });

      await request(ctx.app).delete(`/api/suppressions/${leadEntry.id}`).set(admin()).expect(204);
      await request(ctx.app).delete(`/api/suppressions/${leadEntry.id}`).set(admin()).expect(404);
      await send({ to: ['lead@example.com'], idempotencyKey: 'after-removal' }).expect(200);
    });

    it('validates suppression input', async () => {
      const { mcp, admin } = await setup();
      await request(ctx.app).post('/api/suppressions').set(admin()).send({ address: 'a@b.co', domain: 'b.co', reason: 'x' }).expect(400);
      await request(ctx.app).post('/api/suppressions').set(admin()).send({ domain: 'not a domain', reason: 'x' }).expect(400);
      await request(ctx.app).post('/api/suppressions').set(admin()).send({ address: 'a@b.co' }).expect(400);
      const bad = await mcp('email_suppress', { address: 'a@b.co', reason: '' });
      expect(bad.result?.isError ?? bad.error).toBeTruthy();
    });
  });

  describe('daily cap for new sends', () => {
    it('refuses new sends beyond the rolling 24h cap with a retry time, while replies continue', async () => {
      const { provider, send, reply } = await setup({ maxNewSendsPerAccountPerDay: 2, maxSendsPerAccountPerHour: 100 });
      vi.useFakeTimers({ toFake: ['Date'] });
      const start = new Date('2026-11-09T10:00:00.000Z');
      vi.setSystemTime(start);
      await send({ to: ['a@example.com'], idempotencyKey: 'd1' }).expect(200);
      vi.setSystemTime(new Date('2026-11-09T12:00:00.000Z'));
      await send({ to: ['b@example.com'], idempotencyKey: 'd2' }).expect(200);

      const refused = await send({ to: ['c@example.com'], idempotencyKey: 'd3' }).expect(429);
      expect(refused.body.error.code).toBe('DAILY_SEND_LIMIT_REACHED');
      expect(refused.body.error.message).toContain('2026-11-10T10:00:00.000Z');
      expect(refused.body.error.details).toMatchObject({
        limit: 2,
        windowHours: 24,
        sentInWindow: 2,
        retryAt: '2026-11-10T10:00:00.000Z',
        retryAfterSeconds: 22 * 3600
      });
      expect(provider.sendMessage).toHaveBeenCalledTimes(2);

      // Idempotent replay of an already-sent message is still answered.
      await send({ to: ['a@example.com'], idempotencyKey: 'd1' }).expect(200);
      // Replies are not counted against the cap.
      await reply({ idempotencyKey: 'reply-1' }).expect(200);
      await reply({ idempotencyKey: 'reply-2' }).expect(200);

      vi.setSystemTime(new Date('2026-11-10T10:00:01.000Z'));
      await send({ to: ['c@example.com'], idempotencyKey: 'd3' }).expect(200);
      expect(provider.sendMessage).toHaveBeenCalledTimes(3);
    });

    it('honours a per-account dailySendLimit override stored on the account', async () => {
      const { accountId, send, admin } = await setup({ maxNewSendsPerAccountPerDay: 50 });
      const patched = await request(ctx.app)
        .patch(`/api/accounts/${accountId}`)
        .set(admin())
        .send({ dailySendLimit: 1 })
        .expect(200);
      expect(patched.body.config.dailySendLimit).toBe(1);
      await send({ to: ['a@example.com'], idempotencyKey: 'o1' }).expect(200);
      const refused = await send({ to: ['b@example.com'], idempotencyKey: 'o2' }).expect(429);
      expect(refused.body.error.details.limit).toBe(1);

      await request(ctx.app).patch(`/api/accounts/${accountId}`).set(admin()).send({ dailySendLimit: null }).expect(200);
      await send({ to: ['b@example.com'], idempotencyKey: 'o2' }).expect(200);
      await request(ctx.app).patch(`/api/accounts/${accountId}`).set(admin()).send({ dailySendLimit: -1 }).expect(400);
    });

    it('keeps the hourly limit for replies', async () => {
      const { reply } = await setup({ maxSendsPerAccountPerHour: 1, maxNewSendsPerAccountPerDay: 0 });
      await reply({ idempotencyKey: 'h1' }).expect(200);
      const limited = await reply({ idempotencyKey: 'h2' }).expect(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
    });

    it('treats a limit of 0 as no new sends', async () => {
      const { send } = await setup({ maxNewSendsPerAccountPerDay: 0 });
      const refused = await send({ to: ['a@example.com'], idempotencyKey: 'z1' }).expect(429);
      expect(refused.body.error).toMatchObject({ code: 'DAILY_SEND_LIMIT_REACHED', details: { limit: 0, retryAt: null } });
    });
  });

  describe('html and outgoing attachments', () => {
    const pdf = { filename: 'quote.pdf', contentType: 'application/pdf', contentBase64: Buffer.from('%PDF').toString('base64') };

    it('passes html and validated attachments to the provider for send, reply and draft (REST)', async () => {
      const { accountId, token, provider, send, reply } = await setup();
      await send({ to: ['a@example.com'], html: '<p>Hola</p>', attachments: [pdf], idempotencyKey: 'h1' }).expect(200);
      expect(provider.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'cuerpo',
          html: '<p>Hola</p>',
          attachments: [{ ...pdf, size: 4 }]
        })
      );
      await reply({ html: '<p>Gracias</p>', attachments: [pdf], idempotencyKey: 'h2' }).expect(200);
      expect(provider.replyToMessage).toHaveBeenCalledWith(
        expect.objectContaining({ html: '<p>Gracias</p>', attachments: [{ ...pdf, size: 4 }] })
      );
      await request(ctx.app)
        .post('/api/mail/drafts')
        .set('Authorization', `Bearer ${token}`)
        .send({ accountId, to: ['a@example.com'], subject: 'Draft', text: 'body', html: '<b>x</b>', attachments: [pdf] })
        .expect(200);
      expect(provider.createDraft).toHaveBeenCalledWith(
        expect.objectContaining({ html: '<b>x</b>', attachments: [{ ...pdf, size: 4 }] })
      );
    });

    it('rejects invalid attachments before any provider call or idempotency record', async () => {
      const { provider, send } = await setup({ maxOutgoingAttachments: 1, maxOutgoingAttachmentBytes: 5 });
      const tooMany = await send({ to: ['a@example.com'], attachments: [pdf, pdf], idempotencyKey: 'v1' }).expect(400);
      expect(tooMany.body.error.message).toMatch(/too many attachments/);
      const tooBig = await send({
        to: ['a@example.com'],
        attachments: [{ ...pdf, contentBase64: Buffer.from('123456').toString('base64') }],
        idempotencyKey: 'v1'
      }).expect(400);
      expect(tooBig.body.error.message).toMatch(/exceeds the limit of 5 bytes/);
      const badName = await send({ to: ['a@example.com'], attachments: [{ ...pdf, filename: '../x.pdf' }], idempotencyKey: 'v1' }).expect(400);
      expect(badName.body.error.message).toMatch(/path separators/);
      expect(provider.sendMessage).not.toHaveBeenCalled();
      // The key was never consumed.
      await send({ to: ['a@example.com'], attachments: [pdf], idempotencyKey: 'v1' }).expect(200);
    });

    it('accepts html and attachments on MCP email_send, email_reply and email_create_draft', async () => {
      const { accountId, provider, mcp } = await setup();
      const sent = await mcp('email_send', {
        accountId,
        expectedFrom: 'sales@clasific.ar',
        to: ['a@example.com'],
        subject: 'Hola',
        text: 'cuerpo',
        html: '<p>cuerpo</p>',
        attachments: [pdf],
        idempotencyKey: 'mcp-send'
      });
      expect(sent.result.isError).toBeFalsy();
      expect(provider.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ html: '<p>cuerpo</p>', attachments: [{ ...pdf, size: 4 }] })
      );
      const replied = await mcp('email_reply', {
        accountId,
        expectedFrom: 'sales@clasific.ar',
        messageId: 'message-1',
        to: ['from@example.com'],
        expectedSubject: 'Re: hello',
        text: 'gracias',
        html: '<p>gracias</p>',
        attachments: [pdf],
        idempotencyKey: 'mcp-reply'
      });
      expect(replied.result.isError).toBeFalsy();
      expect(provider.replyToMessage).toHaveBeenCalledWith(
        expect.objectContaining({ html: '<p>gracias</p>', attachments: [{ ...pdf, size: 4 }] })
      );
      const draft = await mcp('email_create_draft', {
        accountId,
        to: ['a@example.com'],
        subject: 'Draft',
        text: 'body',
        attachments: [{ ...pdf, filename: 'a/b.pdf' }]
      });
      expect(draft.result.isError).toBe(true);
      expect(draft.result.structuredContent.code).toBe('INVALID_INPUT');
    });
  });

  describe('incoming attachments', () => {
    it('exposes attachment metadata on get_message and content via REST and MCP', async () => {
      const { accountId, token, provider, mcp } = await setup({ maxAttachmentTextBytes: 4, maxAttachmentBase64Bytes: 3 });
      const attachments = [
        { id: 'att-1', filename: 'data.csv', contentType: 'text/csv', size: 9 },
        { id: 'att-2', filename: 'logo.png', contentType: 'image/png', size: 3 },
        { id: 'att-3', filename: 'big.pdf', contentType: 'application/pdf', size: 4 }
      ];
      const contents: Record<string, Buffer> = {
        'att-1': Buffer.from('a,b\n1,2\n3'),
        'att-2': Buffer.from([1, 2, 3]),
        'att-3': Buffer.from('%PDF')
      };
      (provider.getMessage as ReturnType<typeof vi.fn>).mockImplementation(async (account: string, id: string) => ({
        id,
        accountId: account,
        provider: 'imap_smtp',
        from: { address: 'from@example.com' },
        to: [{ address: 'sales@clasific.ar' }],
        cc: [],
        bcc: [],
        subject: 'Files',
        date: new Date().toISOString(),
        text: 'see attached',
        attachments
      }));
      const load = vi.fn(async (id: string) => contents[id]!);
      Object.assign(provider, {
        getAttachment: vi.fn(async (_account: string, _message: string, attachmentId: string) => {
          const meta = attachments.find((entry) => entry.id === attachmentId)!;
          return { ...meta, load: () => load(attachmentId) };
        })
      });

      const message = await request(ctx.app)
        .get(`/api/mail/messages/${accountId}/message-1`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(message.body.attachments).toEqual(attachments);
      const mcpMessage = await mcp('email_get_message', { accountId, messageId: 'message-1' });
      expect(JSON.parse(mcpMessage.result.content[0].text).attachments).toEqual(attachments);

      const text = await request(ctx.app)
        .get(`/api/mail/messages/${accountId}/message-1/attachments/att-1`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(text.body).toEqual({
        id: 'att-1', filename: 'data.csv', contentType: 'text/csv', size: 9, encoding: 'text', content: 'a,b\n', truncated: true
      });

      const binary = await mcp('email_get_attachment', { accountId, messageId: 'message-1', attachmentId: 'att-2' });
      expect(binary.result.structuredContent).toMatchObject({
        encoding: 'base64',
        content: Buffer.from([1, 2, 3]).toString('base64'),
        truncated: false
      });

      const tooLarge = await mcp('email_get_attachment', { accountId, messageId: 'message-1', attachmentId: 'att-3' });
      expect(tooLarge.result.isError).toBe(true);
      expect(tooLarge.result.structuredContent).toMatchObject({ code: 'ATTACHMENT_TOO_LARGE', details: { size: 4, maxBytes: 3 } });
      expect(load).not.toHaveBeenCalledWith('att-3');
    });

    it('returns a clear error when the provider cannot download attachments', async () => {
      const { accountId, token, provider } = await setup();
      expect((provider as { getAttachment?: unknown }).getAttachment).toBeUndefined();
      const response = await request(ctx.app)
        .get(`/api/mail/messages/${accountId}/message-1/attachments/1`)
        .set('Authorization', `Bearer ${token}`)
        .expect(405);
      expect(response.body.error).toMatchObject({ code: 'NOT_SUPPORTED', message: expect.stringMatching(/not supported by this provider/) });
    });

    it('requires read permission for email_get_attachment', async () => {
      ctx = createTestContext();
      const account = await request(ctx.app)
        .post('/api/accounts/proton-bridge')
        .set('Authorization', `Bearer ${ctx.config.adminKey}`)
        .send({
          emailAddress: 'x@clasific.ar', displayName: 'X', imapHost: '127.0.0.1', imapPort: 1143, imapTlsMode: 'ssl',
          smtpHost: '127.0.0.1', smtpPort: 1025, smtpTlsMode: 'starttls', username: 'x', password: 'secret'
        })
        .expect(201);
      const { token } = await createProfileAndToken(ctx, account.body.id, { readEnabled: false, sendEnabled: true });
      await request(ctx.app)
        .get(`/api/mail/messages/${account.body.id}/m/attachments/1`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });
  });
});
