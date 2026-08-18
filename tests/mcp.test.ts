import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

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

    const token = (await request(ctx.app)
      .post(`/api/access-profiles/${tokenRes.body.id}/tokens`)
      .set('Authorization', `Bearer ${ctx.config.adminKey}`)
      .expect(201)).body.token;

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
      items: [{
        id: first.body.id,
        email: 'alpha@clasific.ar'
      }]
    });
    expect(String(items)).toContain('accounts: 1');
  });
});
