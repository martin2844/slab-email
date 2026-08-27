import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EmailMessageCompact } from '../src/types/models.js';
import { DatabaseService } from '../src/db/database.js';
import { createFakeProvider } from './fakes.js';
import { createTestContext } from './helpers.js';

const accountAddress = 'automation@example.com';

const message = (id: string, overrides: Partial<EmailMessageCompact> = {}): EmailMessageCompact => ({
  id,
  accountId: '',
  threadId: `thread-${id}`,
  from: { address: 'sender@example.net', name: 'Sender' },
  to: [{ address: accountAddress }],
  subject: `Subject ${id}`,
  date: '2026-08-27T10:00:00.000Z',
  snippet: `private body excerpt ${id}`,
  unread: true,
  ...overrides
});

describe('durable inbound email events', () => {
  let context: ReturnType<typeof createTestContext>;
  let accountId: string;

  beforeEach(() => {
    context = createTestContext();
    accountId = randomUUID();
    context.db.upsertEmailAccount({
      id: accountId,
      provider: 'imap_smtp',
      emailAddress: accountAddress,
      displayName: 'Automation inbox',
      enabled: true,
      config: {
        emailAddress: accountAddress,
        displayName: 'Automation inbox',
        imapHost: 'imap.example.com',
        imapPort: 993,
        imapTlsMode: 'ssl',
        smtpHost: 'smtp.example.com',
        smtpPort: 465,
        smtpTlsMode: 'ssl'
      }
    });
  });

  afterEach(() => {
    context.cleanup();
  });

  it('baselines existing mail, emits new inbound metadata once, and stops at the seen boundary', async () => {
    const provider = createFakeProvider();
    const search = vi.fn();
    provider.searchMessages = search;
    vi.spyOn(context.accountService, 'getProviderForAccount').mockResolvedValue(provider);

    search.mockResolvedValueOnce({
      items: [message('existing')],
      nextCursor: 'older'
    });
    search.mockResolvedValueOnce({ items: [message('older')] });
    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      accounts: 1,
      discovered: 2,
      emitted: 0,
      failed: 0
    });
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[0]?.[0].since).toBeUndefined();
    expect(search.mock.calls[0]?.[0].inboundOnly).toBe(true);

    search.mockResolvedValueOnce({
      items: [
        message('new'),
        message('bcc', { to: [{ address: 'undisclosed-recipients@example.net' }] }),
        message('existing')
      ],
      nextCursor: 'must-not-be-read'
    });
    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      discovered: 2,
      emitted: 2,
      failed: 0
    });
    expect(search).toHaveBeenCalledTimes(3);
    expect(search.mock.calls[2]?.[0].since).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const unauthorized = await request(context.app).get('/api/inbound/events');
    expect(unauthorized.status).toBe(401);

    const response = await request(context.app)
      .get('/api/inbound/events')
      .set('Authorization', `Bearer ${context.config.adminKey}`)
      .query({ after: 0, accountId, limit: 10 })
      .expect(200);
    expect(response.body).toEqual({
      items: [
        expect.objectContaining({
          id: 1,
          accountId,
          provider: 'imap_smtp',
          messageId: 'new',
          threadId: 'thread-new',
          subject: 'Subject new'
        }),
        expect.objectContaining({
          id: 2,
          accountId,
          messageId: 'bcc'
        })
      ],
      nextCursor: '2'
    });
    expect(JSON.stringify(response.body)).not.toContain('private body excerpt');
    expect(response.body.items[0]).not.toHaveProperty('snippet');

    search.mockResolvedValueOnce({
      items: [message('new'), message('existing')]
    });
    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      discovered: 0,
      emitted: 0,
      failed: 0
    });
    expect(context.db.listInboundEvents({ afterId: 2 }).items).toEqual([]);
  });

  it('preserves the live-mail boundary across cosmetic and SMTP-only edits', async () => {
    const provider = createFakeProvider();
    const search = vi
      .fn()
      .mockResolvedValueOnce({ items: [message('existing')] })
      .mockResolvedValueOnce({ items: [message('new'), message('existing')] });
    provider.searchMessages = search;
    vi.spyOn(context.accountService, 'getProviderForAccount').mockResolvedValue(provider);

    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      emitted: 0,
      failed: 0
    });
    const generation = context.db.getEmailAccountInboundGeneration(accountId);
    const initializedAt = context.db.getInboundPollState(accountId)?.initializedAt;

    context.accountService.updateAccount(accountId, {
      displayName: 'Renamed automation inbox',
      smtpHost: 'smtp2.example.com',
      smtpPort: 587,
      smtpTlsMode: 'starttls',
      smtpMessageIdDomain: 'mail.example.com'
    });

    expect(context.db.getEmailAccountInboundGeneration(accountId)).toBe(generation);
    expect(context.db.getInboundPollState(accountId)?.initializedAt).toBe(initializedAt);
    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      discovered: 1,
      emitted: 1,
      failed: 0
    });
    expect(context.db.listInboundEvents({}).items).toEqual([
      expect.objectContaining({ messageId: 'new' })
    ]);

    search.mockResolvedValueOnce({ items: [message('replacement-existing')] });
    context.accountService.updateAccount(accountId, {
      imapHost: 'replacement-imap.example.com'
    });
    expect(context.db.getEmailAccountInboundGeneration(accountId)).toBe(
      (generation ?? 0) + 1
    );
    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      discovered: 1,
      emitted: 0,
      failed: 0
    });
    expect(context.db.listInboundEvents({}).items).toHaveLength(1);
  });

  it('preserves the live-mail boundary across an idempotent enable request', async () => {
    const provider = createFakeProvider();
    provider.searchMessages = vi
      .fn()
      .mockResolvedValueOnce({ items: [message('existing')] })
      .mockResolvedValueOnce({ items: [message('new'), message('existing')] });
    vi.spyOn(context.accountService, 'getProviderForAccount').mockResolvedValue(provider);

    await context.inboundEventService.pollNow();
    const generation = context.db.getEmailAccountInboundGeneration(accountId);
    context.accountService.setEnabled(accountId, true);

    expect(context.db.getEmailAccountInboundGeneration(accountId)).toBe(generation);
    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      discovered: 1,
      emitted: 1,
      failed: 0
    });
    expect(context.db.listInboundEvents({}).items).toEqual([
      expect.objectContaining({ messageId: 'new' })
    ]);
  });

  it('rejects a provider snapshot when another connection changes the account after generation capture', async () => {
    const provider = createFakeProvider();
    vi.spyOn(context.accountService, 'getProviderForAccount').mockResolvedValue(provider);
    const observer = new DatabaseService(context.config.databasePath, {
      migrate: false
    });
    const originalGetAccount = context.accountService.getAccount.bind(
      context.accountService
    );
    vi.spyOn(context.accountService, 'getAccount').mockImplementationOnce((id) => {
      const stale = originalGetAccount(id);
      observer.setAccountEnabled(id, false);
      return stale;
    });

    try {
      await expect(
        context.accountService.getInboundProviderSnapshot(accountId)
      ).rejects.toThrow('email account changed while creating provider');
    } finally {
      observer.close();
    }
  });

  it('records an initial failure without treating the next successful scan as a live event', async () => {
    const provider = createFakeProvider();
    provider.searchMessages = vi
      .fn()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce({ items: [message('baseline')] })
      .mockResolvedValueOnce({ items: [message('new'), message('baseline')] });
    vi.spyOn(context.accountService, 'getProviderForAccount').mockResolvedValue(provider);

    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      failed: 1
    });
    expect(context.db.getInboundPollState(accountId)).toMatchObject({
      accountId,
      initializedAt: null,
      lastError: 'provider unavailable'
    });

    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      discovered: 1,
      emitted: 0,
      failed: 0
    });
    expect(context.db.getInboundPollState(accountId)).toMatchObject({
      accountId,
      lastError: null
    });
    expect(context.db.getInboundPollState(accountId)?.initializedAt).toBeTruthy();

    const polled = await request(context.app)
      .post('/api/inbound/poll')
      .set('Authorization', `Bearer ${context.config.adminKey}`)
      .expect(200);
    expect(polled.body).toMatchObject({ emitted: 1, failed: 0 });

    const status = await request(context.app)
      .get('/api/inbound/status')
      .set('x-slab-admin-key', context.config.adminKey)
      .expect(200);
    expect(status.body.accounts).toEqual([expect.objectContaining({ accountId, lastError: null })]);
  });

  it('persists bounded scan progress and resumes without losing or duplicating events', async () => {
    const provider = createFakeProvider();
    const search = vi.fn(async (input: { cursor?: string }) => {
      const page = Number.parseInt(input.cursor ?? '0', 10);
      return {
        items: [message(`page-${page}`)],
        nextCursor: page < 50 ? String(page + 1) : undefined
      };
    });
    provider.searchMessages = search;
    vi.spyOn(context.accountService, 'getProviderForAccount').mockResolvedValue(provider);

    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      discovered: 50,
      emitted: 0,
      deferred: 1,
      failed: 0
    });
    expect(context.db.getInboundPollState(accountId)).toMatchObject({
      initializedAt: null,
      scanCursor: '50'
    });

    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      discovered: 1,
      emitted: 0,
      deferred: 0,
      failed: 0
    });
    expect(search.mock.calls.at(-1)?.[0].cursor).toBe('50');
    expect(context.db.getInboundPollState(accountId)).toMatchObject({
      scanCursor: null,
      scanStartedAt: null
    });
    expect(context.db.getInboundPollState(accountId)?.initializedAt).toBeTruthy();

    search.mockReset();
    search.mockImplementation(async (input: { cursor?: string }) => {
      const page = Number.parseInt(input.cursor ?? '0', 10);
      return {
        items: [message(`live-${page}`)],
        nextCursor: page < 50 ? String(page + 1) : undefined
      };
    });
    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      discovered: 50,
      emitted: 50,
      deferred: 1,
      failed: 0
    });
    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      discovered: 1,
      emitted: 1,
      deferred: 0,
      failed: 0
    });
    expect(context.db.listInboundEvents({ limit: 100 }).items).toHaveLength(51);
  });

  it('silently restarts page one when a non-IMAP account generation changes', async () => {
    const provider = createFakeProvider();
    const search = vi.fn().mockResolvedValueOnce({ items: [message('a-baseline')] });
    provider.searchMessages = search;
    vi.spyOn(context.accountService, 'getProviderForAccount').mockResolvedValue(provider);
    await context.inboundEventService.pollNow();

    search.mockImplementation(async (input: { cursor?: string }) => {
      const page = Number.parseInt(input.cursor ?? '0', 10);
      return {
        items: [message(`a-live-${page}`)],
        nextCursor: String(page + 1)
      };
    });
    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      emitted: 50,
      deferred: 1,
      failed: 0
    });
    expect(context.db.getInboundPollState(accountId)?.scanCursor).toBe('50');

    context.db.upsertEmailAccount({
      id: accountId,
      provider: 'agentmail',
      emailAddress: accountAddress,
      displayName: 'Replacement AgentMail inbox',
      enabled: true,
      config: {
        emailAddress: accountAddress,
        displayName: 'Replacement AgentMail inbox',
        inboxId: 'replacement@agentmail.to',
        baseUrl: 'https://api.agentmail.to/v0'
      }
    });
    search.mockReset();
    search
      .mockResolvedValueOnce({ items: [message('b-existing')] })
      .mockResolvedValueOnce({
        items: [message('b-new'), message('b-existing')]
      });

    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      emitted: 0,
      failed: 0
    });
    expect(search.mock.calls[0]?.[0].cursor).toBeUndefined();
    expect(context.db.getInboundPollState(accountId)).toMatchObject({
      scanCursor: null,
      identityEpoch: null
    });
    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      emitted: 1,
      failed: 0
    });
    expect(
      context.db.listInboundEvents({ limit: 100 }).items.at(-1)?.messageId
    ).toBe('b-new');
  });

  it('treats account deletion during a poll as a benign cancellation', async () => {
    const provider = createFakeProvider();
    provider.searchMessages = vi.fn(async () => {
      context.db.removeEmailAccount(accountId);
      return { items: [message('raced')] };
    });
    vi.spyOn(context.accountService, 'getProviderForAccount').mockResolvedValue(provider);

    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      failed: 0,
      emitted: 0
    });
  });

  it('rolls back a page when the account is repointed during provider I/O', async () => {
    const provider = createFakeProvider();
    provider.searchMessages = vi.fn(async () => {
      context.db.upsertEmailAccount({
        id: accountId,
        provider: 'imap_smtp',
        emailAddress: accountAddress,
        displayName: 'Replacement inbox',
        enabled: true,
        config: {
          emailAddress: accountAddress,
          displayName: 'Replacement inbox',
          imapHost: 'replacement.example.com',
          imapPort: 993,
          imapTlsMode: 'ssl',
          smtpHost: 'smtp.example.com',
          smtpPort: 465,
          smtpTlsMode: 'ssl'
        }
      });
      return { items: [message('old-mailbox-message')] };
    });
    vi.spyOn(context.accountService, 'getProviderForAccount').mockResolvedValue(provider);

    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      emitted: 0,
      failed: 0
    });
    expect(context.db.listInboundEvents({}).items).toEqual([]);
  });

  it('restarts a failed continuation without treating partial pages as the old-mail boundary', async () => {
    const provider = createFakeProvider();
    const search = vi
      .fn()
      .mockResolvedValueOnce({ items: [message('baseline')] })
      .mockResolvedValueOnce({
        items: [message('first-live')],
        nextCursor: 'stale'
      })
      .mockRejectedValueOnce(new Error('invalid provider cursor'))
      .mockResolvedValueOnce({
        items: [message('first-live')],
        nextCursor: 'page-2'
      })
      .mockResolvedValueOnce({ items: [message('second-live')] });
    provider.searchMessages = search;
    vi.spyOn(context.accountService, 'getProviderForAccount').mockResolvedValue(provider);

    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      emitted: 0,
      failed: 0
    });
    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      emitted: 1,
      failed: 1
    });
    expect(context.db.getInboundPollState(accountId)).toMatchObject({
      scanCursor: null,
      lastError: 'invalid provider cursor'
    });
    const originalScanStart = context.db.getInboundPollState(accountId)?.scanStartedAt;
    expect(originalScanStart).toBeTruthy();

    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      discovered: 1,
      emitted: 1,
      failed: 0
    });
    expect(context.db.getInboundPollState(accountId)?.scanStartedAt).toBeNull();
    expect(context.db.listInboundEvents({ limit: 100 }).items.map((event) => event.messageId)).toEqual([
      'first-live',
      'second-live'
    ]);
  });

  it('silently rebaselines an IMAP UIDVALIDITY change before emitting new mail', async () => {
    const provider = createFakeProvider();
    const search = vi
      .fn()
      .mockResolvedValueOnce({
        items: [message('41:7')],
        identityEpoch: 'imap-uidvalidity:41'
      })
      .mockResolvedValueOnce({
        items: [message('41:8')],
        nextCursor: 'old-offset',
        identityEpoch: 'imap-uidvalidity:41'
      })
      .mockResolvedValueOnce({
        items: [message('42:7')],
        identityEpoch: 'imap-uidvalidity:42'
      })
      .mockResolvedValueOnce({
        items: [message('42:8'), message('42:7')],
        identityEpoch: 'imap-uidvalidity:42'
      })
      .mockResolvedValueOnce({
        items: [message('42:9'), message('42:8')],
        identityEpoch: 'imap-uidvalidity:42'
      });
    provider.searchMessages = search;
    vi.spyOn(context.accountService, 'getProviderForAccount').mockResolvedValue(provider);

    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      emitted: 0,
      failed: 0
    });
    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      emitted: 1,
      deferred: 1,
      failed: 0
    });
    expect(context.db.getInboundPollState(accountId)).toMatchObject({
      initializedAt: null,
      scanCursor: null,
      identityEpoch: 'imap-uidvalidity:42'
    });

    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      emitted: 0,
      failed: 0
    });
    await expect(context.inboundEventService.pollNow()).resolves.toMatchObject({
      emitted: 1,
      failed: 0
    });
    expect(context.db.listInboundEvents({ limit: 100 }).items.map((event) => event.messageId)).toEqual([
      '41:8',
      '42:9'
    ]);
  });
});
