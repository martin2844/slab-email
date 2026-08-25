import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import { createFakeProvider } from './fakes.js';
import { createTestContext } from './helpers.js';

const parseMcpStreamResponse = (body: string): Record<string, unknown> => {
  const dataLine = body
    .split('\n')
    .reverse()
    .find((line) => line.startsWith('data: '));

  if (!dataLine) {
    return {};
  }

  const payload = dataLine.slice('data: '.length).trim();
  return payload ? (JSON.parse(payload) as Record<string, unknown>) : {};
};

describe('MCP endpoint', () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('requires a scoped connector token', async () => {
    const res = await request(ctx.app).post('/mcp').send({ jsonrpc: '2.0', method: 'tools/list' }).expect(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('returns scoped account list through tools/list', async () => {
    const first = await request(ctx.app)
      .post('/api/accounts/proton-bridge')
      .set('Authorization', `Bearer ${ctx.config.adminKey}`)
      .send({
        emailAddress: 'alpha@clasific.ar',
        displayName: 'Alpha',
        imapHost: '127.0.0.1',
        imapPort: 1143,
        imapTlsMode: 'ssl',
        smtpHost: '127.0.0.1',
        smtpPort: 1025,
        smtpTlsMode: 'starttls',
        username: 'alpha',
        password: 'secret'
      })
      .expect(201);

    const tokenRes = await request(ctx.app)
      .post('/api/access-profiles')
      .set('Authorization', `Bearer ${ctx.config.adminKey}`)
      .send({
        name: 'MCP',
        readEnabled: true,
        draftEnabled: false,
        sendEnabled: false,
        accountIds: [first.body.id]
      })
      .expect(201);

    const token = (
      await request(ctx.app).post(`/api/access-profiles/${tokenRes.body.id}/tokens`).set('Authorization', `Bearer ${ctx.config.adminKey}`).expect(201)
    ).body.token;

    const listRes = await request(ctx.app)
      .post('/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list'
      })
      .expect(200);

    const listBody = parseMcpStreamResponse(listRes.text);
    const tools = listBody?.result?.tools as Array<{ name: string }>;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.map(({ name }) => name)).toContain('email_list_accounts');
    expect(tools.map(({ name }) => name)).not.toContain('email_send');
    expect(tools.map(({ name }) => name)).not.toContain('email_create_draft');

    const toolCall = await request(ctx.app)
      .post('/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'email_list_accounts',
          arguments: {}
        }
      })
      .expect(200);

    const callBody = parseMcpStreamResponse(toolCall.text);
    const items = callBody?.result?.content?.[0]?.text;
    expect(typeof items).toBe('string');
    expect(callBody.result.structuredContent).toMatchObject({
      items: [
        {
          id: first.body.id,
          email: 'alpha@clasific.ar',
          displayName: 'Alpha',
          sendAs: {
            email: 'alpha@clasific.ar',
            displayName: 'Alpha'
          }
        }
      ]
    });
    expect(String(items)).toContain('accounts: 1');
  });

  it('allows scoped email_search and rejects email_send without send permission', async () => {
    const provider = createFakeProvider({
      searchResult: [
        {
          id: 'message-1',
          accountId: 'account-placeholder',
          from: { address: 'buyer@example.com' },
          to: [{ address: 'sales@example.com' }],
          subject: 'Pricing question',
          date: new Date().toISOString(),
          snippet: 'Can you share pricing?',
          threadId: 'thread-1'
        }
      ]
    });
    vi.spyOn(ctx.accountService, 'getProviderForAccount').mockResolvedValue(provider);
    const account = await request(ctx.app)
      .post('/api/accounts/proton-bridge')
      .set('Authorization', `Bearer ${ctx.config.adminKey}`)
      .send({
        emailAddress: 'sales@clasific.ar',
        displayName: 'Sales',
        imapHost: '127.0.0.1',
        imapPort: 1143,
        imapTlsMode: 'starttls',
        smtpHost: '127.0.0.1',
        smtpPort: 1025,
        smtpTlsMode: 'starttls',
        username: 'bridge-user',
        password: 'bridge-password'
      })
      .expect(201);
    const profile = await request(ctx.app)
      .post('/api/access-profiles')
      .set('Authorization', `Bearer ${ctx.config.adminKey}`)
      .send({
        name: 'sales',
        readEnabled: true,
        draftEnabled: false,
        sendEnabled: false,
        accountIds: [account.body.id]
      })
      .expect(201);
    const token = (
      await request(ctx.app).post(`/api/access-profiles/${profile.body.id}/tokens`).set('Authorization', `Bearer ${ctx.config.adminKey}`).expect(201)
    ).body.token;

    const call = async (id: number, name: string, args: Record<string, unknown>) => {
      const response = await request(ctx.app)
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args }
        })
        .expect(200);
      return parseMcpStreamResponse(response.text);
    };

    const search = await call(10, 'email_search', {
      accountId: account.body.id,
      query: 'pricing',
      limit: 5
    });
    expect(search.result.structuredContent.items).toHaveLength(1);

    const send = await call(11, 'email_send', {
      accountId: account.body.id,
      expectedFrom: 'sales@clasific.ar',
      to: ['buyer@example.com'],
      subject: 'Pricing',
      text: 'Hello',
      idempotencyKey: 'test-send-denied'
    });
    expect(send.result.structuredContent).toMatchObject({
      code: 'PERMISSION_DENIED'
    });
  });

  it('rejects an agentic send when expectedFrom is not the connected sender', async () => {
    const provider = createFakeProvider();
    vi.spyOn(ctx.accountService, 'getProviderForAccount').mockResolvedValue(provider);
    const account = await request(ctx.app)
      .post('/api/accounts/proton-bridge')
      .set('Authorization', `Bearer ${ctx.config.adminKey}`)
      .send({
        emailAddress: 'clasificar@pm.me',
        displayName: 'Martin Clasificar',
        imapHost: '127.0.0.1',
        imapPort: 1143,
        imapTlsMode: 'starttls',
        smtpHost: '127.0.0.1',
        smtpPort: 1025,
        smtpTlsMode: 'starttls',
        username: 'bridge-user',
        password: 'bridge-password'
      })
      .expect(201);
    const profile = await request(ctx.app)
      .post('/api/access-profiles')
      .set('Authorization', `Bearer ${ctx.config.adminKey}`)
      .send({
        name: 'clara',
        readEnabled: true,
        draftEnabled: false,
        sendEnabled: true,
        accountIds: [account.body.id]
      })
      .expect(201);
    const token = (
      await request(ctx.app).post(`/api/access-profiles/${profile.body.id}/tokens`).set('Authorization', `Bearer ${ctx.config.adminKey}`).expect(201)
    ).body.token;

    const response = await request(ctx.app)
      .post('/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'email_send',
          arguments: {
            accountId: account.body.id,
            expectedFrom: 'clara@clasific.ar',
            to: ['buyer@example.com'],
            subject: 'Follow-up',
            text: 'Hello',
            idempotencyKey: 'sender-mismatch'
          }
        }
      })
      .expect(200);
    const result = parseMcpStreamResponse(response.text);
    expect(result.result.structuredContent).toMatchObject({
      code: 'SENDER_IDENTITY_MISMATCH',
      details: {
        expectedFrom: 'clara@clasific.ar',
        actualFrom: 'clasificar@pm.me'
      }
    });
    expect(provider.sendMessage).not.toHaveBeenCalled();
  });

  it('lets send-only profiles discover sender identities and enforces the approved reply plan', async () => {
    const provider = createFakeProvider();
    vi.spyOn(ctx.accountService, 'getProviderForAccount').mockResolvedValue(provider);
    const account = await request(ctx.app)
      .post('/api/accounts/proton-bridge')
      .set('Authorization', `Bearer ${ctx.config.adminKey}`)
      .send({
        emailAddress: 'clara@clasific.ar',
        displayName: 'Clara',
        imapHost: '127.0.0.1',
        imapPort: 1143,
        imapTlsMode: 'starttls',
        smtpHost: '127.0.0.1',
        smtpPort: 1025,
        smtpTlsMode: 'starttls',
        username: 'bridge-user',
        password: 'bridge-password'
      })
      .expect(201);
    const profile = await request(ctx.app)
      .post('/api/access-profiles')
      .set('Authorization', `Bearer ${ctx.config.adminKey}`)
      .send({
        name: 'send-only',
        readEnabled: false,
        draftEnabled: false,
        sendEnabled: true,
        accountIds: [account.body.id]
      })
      .expect(201);
    const token = (
      await request(ctx.app).post(`/api/access-profiles/${profile.body.id}/tokens`).set('Authorization', `Bearer ${ctx.config.adminKey}`).expect(201)
    ).body.token;
    const call = async (id: number, name: string, args: Record<string, unknown>) => {
      const response = await request(ctx.app)
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
        .expect(200);
      return parseMcpStreamResponse(response.text);
    };

    const toolsResponse = await request(ctx.app)
      .post('/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 20, method: 'tools/list' })
      .expect(200);
    const tools = parseMcpStreamResponse(toolsResponse.text).result.tools as Array<{
      name: string;
      inputSchema?: { properties?: Record<string, unknown> };
    }>;
    expect(tools.map(({ name }) => name)).toContain('email_list_accounts');
    expect(tools.map(({ name }) => name)).toContain('email_send');
    expect(tools.map(({ name }) => name)).not.toContain('email_reply');
    const visibleAccounts = await call(21, 'email_list_accounts', {});
    expect(visibleAccounts.result.structuredContent).toMatchObject({
      items: [{ id: account.body.id, email: 'clara@clasific.ar' }]
    });

    ctx.accessProfileService.update(profile.body.id, {
      name: 'no-send',
      readEnabled: false,
      draftEnabled: false,
      sendEnabled: false,
      accountIds: [account.body.id]
    });
    await request(ctx.app)
      .post('/api/mail/reply')
      .set('Authorization', `Bearer ${token}`)
      .send({
        accountId: account.body.id,
        expectedFrom: 'clara@clasific.ar',
        expectedSubject: 'Re: hello',
        messageId: 'message-1',
        to: ['from@example.com'],
        text: 'Reply body',
        idempotencyKey: 'reply-denied'
      })
      .expect(403);
    expect(provider.getMessage).not.toHaveBeenCalled();

    ctx.accessProfileService.update(profile.body.id, {
      name: 'read-and-send',
      readEnabled: true,
      draftEnabled: false,
      sendEnabled: true,
      accountIds: [account.body.id]
    });
    const readableToolsResponse = await request(ctx.app)
      .post('/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 22, method: 'tools/list' })
      .expect(200);
    const readableTools = parseMcpStreamResponse(readableToolsResponse.text).result.tools as Array<{
      name: string;
      inputSchema?: { properties?: Record<string, unknown> };
    }>;
    const replyTool = readableTools.find(({ name }) => name === 'email_reply');
    expect(replyTool?.inputSchema?.properties).not.toHaveProperty('html');
    expect(replyTool?.inputSchema?.properties).not.toHaveProperty('replyAll');

    const mismatch = await call(23, 'email_reply', {
      accountId: account.body.id,
      expectedFrom: 'clara@clasific.ar',
      messageId: 'message-1',
      to: ['wrong@example.com'],
      expectedSubject: 'Re: hello',
      text: 'Reply body',
      idempotencyKey: 'reply-mismatch'
    });
    expect(mismatch.result.structuredContent).toMatchObject({
      code: 'REPLY_PLAN_MISMATCH'
    });
    expect(provider.replyToMessage).not.toHaveBeenCalled();

    const sent = await call(24, 'email_reply', {
      accountId: account.body.id,
      expectedFrom: 'clara@clasific.ar',
      messageId: 'message-1',
      to: ['from@example.com'],
      expectedSubject: 'Re: hello',
      text: 'Reply body',
      idempotencyKey: 'reply-exact'
    });
    expect(sent.result.structuredContent).toMatchObject({ status: 'sent' });
    expect(provider.replyToMessage).toHaveBeenCalledTimes(1);
    const readsBeforeRetry = vi.mocked(provider.getMessage).mock.calls.length;
    vi.mocked(provider.getMessage).mockRejectedValueOnce(new Error('source unavailable'));
    const retried = await call(25, 'email_reply', {
      accountId: account.body.id,
      expectedFrom: 'clara@clasific.ar',
      messageId: 'message-1',
      to: ['from@example.com'],
      expectedSubject: 'Re: hello',
      text: 'Reply body',
      idempotencyKey: 'reply-exact'
    });
    expect(retried.result.structuredContent).toMatchObject({ status: 'sent' });
    expect(vi.mocked(provider.getMessage).mock.calls).toHaveLength(readsBeforeRetry);
  });
});
