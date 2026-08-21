import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentMailProvider } from '../src/providers/agentmail/provider.js';
import { MicrosoftGraphProvider } from '../src/providers/microsoft-graph/provider.js';
import { ResendProvider } from '../src/providers/resend/provider.js';

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('API email providers', () => {
  it('normalizes AgentMail search, drafts, threads, send and reply', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/messages/search')) {
        return json({ messages: [{ message_id: 'm1', thread_id: 't1', from: 'Ada <ada@example.com>', to: ['sales@agentmail.to'], subject: 'Demo', preview: 'Next week', timestamp: '2026-08-21T10:00:00Z', labels: ['unread'] }] });
      }
      if (url.endsWith('/threads/t1')) return json({ messages: [{ message_id: 'm1', thread_id: 't1', from: 'ada@example.com', to: ['sales@agentmail.to'], subject: 'Demo', text: 'Body', timestamp: '2026-08-21T10:00:00Z' }] });
      if (url.endsWith('/drafts')) return json({ draft_id: 'd1', thread_id: 't1' });
      if (url.endsWith('/messages/send')) return json({ message_id: 'sent1', thread_id: 't2' });
      if (url.endsWith('/messages/m1/reply')) return json({ message_id: 'reply1', thread_id: 't1' });
      return json({ inbox_id: 'sales@agentmail.to' });
    }));
    const provider = new AgentMailProvider({
      emailAddress: 'sales@agentmail.to', displayName: 'Sales', inboxId: 'sales@agentmail.to',
      apiKey: 'agentmail-key', baseUrl: 'https://api.agentmail.to/v0',
    });

    const search = await provider.searchMessages({ accountId: 'a1', query: 'demo next week' });
    expect(search.items[0]).toMatchObject({ id: 'm1', accountId: 'a1', unread: true, subject: 'Demo' });
    expect(await provider.getThread('a1', 't1')).toHaveLength(1);
    expect(await provider.createDraft({ accountId: 'a1', to: [{ address: 'person@example.com' }], subject: 'Draft', text: 'Body' })).toEqual({ draftId: 'd1', threadId: 't1' });
    expect((await provider.sendMessage({ accountId: 'a1', to: [{ address: 'person@example.com' }], subject: 'Hi', text: 'Body', idempotencyKey: 'once' })).providerMessageId).toBe('sent1');
    expect((await provider.replyToMessage({ accountId: 'a1', messageId: 'm1', text: 'Thanks', idempotencyKey: 'reply-once' })).providerThreadId).toBe('t1');
    expect(calls.every(({ init }) => new Headers(init?.headers).get('Authorization') === 'Bearer agentmail-key')).toBe(true);
  });

  it('keeps Resend capabilities honest and uses provider idempotency', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/emails/receiving/received-1')) return json({ id: 'received-1', from: 'lead@example.com', to: ['sales@example.com'], subject: 'Question', created_at: '2026-08-21T10:00:00Z', text: 'Hello' });
      if (url.includes('/emails/receiving')) return json({ data: [{ id: 'received-1', from: 'lead@example.com', to: ['sales@example.com'], subject: 'Question', created_at: '2026-08-21T10:00:00Z' }], has_more: false });
      if (url.endsWith('/emails')) return json({ id: 'sent-1' });
      return json({ data: [] });
    }));
    const sendOnly = new ResendProvider({ emailAddress: 'sales@example.com', displayName: 'Sales', apiKey: 're_key', baseUrl: 'https://api.resend.com', inboundEnabled: false });
    expect(sendOnly.getCapabilities()).toMatchObject({ read: false, search: false, draft: false, send: true, reply: false, threads: false });
    const inbound = new ResendProvider({ emailAddress: 'sales@example.com', displayName: 'Sales', apiKey: 're_key', baseUrl: 'https://api.resend.com', inboundEnabled: true });
    expect((await inbound.searchMessages({ accountId: 'a2' })).items[0].id).toBe('received-1');
    expect((await inbound.getMessage('a2', 'received-1')).text).toBe('Hello');
    expect((await inbound.sendMessage({ accountId: 'a2', to: [{ address: 'lead@example.com' }], subject: 'Hello', text: 'Hi', idempotencyKey: 'resend-once' })).providerMessageId).toBe('sent-1');
    const send = calls.find(({ url }) => url.endsWith('/emails'))!;
    expect(new Headers(send.init?.headers).get('Idempotency-Key')).toBe('resend-once');
  });

  it('refreshes Microsoft tokens and maps Graph messages', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('/oauth2/v2.0/token')) return json({ access_token: 'graph-token', expires_in: 3600 });
      if (url.includes('/me/messages?')) return json({ value: [{ id: 'g1', conversationId: 'c1', from: { emailAddress: { name: 'Lead', address: 'lead@example.com' } }, toRecipients: [{ emailAddress: { address: 'sales@example.com' } }], subject: 'Pricing', bodyPreview: 'Can we talk?', receivedDateTime: '2026-08-21T10:00:00Z', isRead: false }] });
      if (url.includes('/me?')) return json({ mail: 'sales@example.com' });
      return json(undefined, 202);
    }));
    const provider = new MicrosoftGraphProvider({ emailAddress: 'sales@example.com', displayName: 'Sales', refreshToken: 'refresh', clientId: 'client', clientSecret: 'secret', tenant: 'common' });
    expect((await provider.verifyConnection()).status).toBe('ok');
    const search = await provider.searchMessages({ accountId: 'a3', subject: 'pricing' });
    expect(search.items[0]).toMatchObject({ id: 'g1', threadId: 'c1', unread: true });
    expect(calls.filter((url) => url.includes('/oauth2/v2.0/token'))).toHaveLength(1);
  });
});
