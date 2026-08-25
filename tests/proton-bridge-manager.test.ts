import { afterEach, describe, expect, it } from 'vitest';

import { ManagedProtonBridge, type ProtonBridgeController, type ProtonBridgeControllerResult } from '../src/services/proton-bridge-manager.js';
import { createTestContext } from './helpers.js';

class FakeController implements ProtonBridgeController {
  started = false;
  stopped = false;
  calls: Array<{ action: string; input?: Record<string, unknown> }> = [];
  responses: ProtonBridgeControllerResult[] = [];

  async start() {
    this.started = true;
  }

  async stop() {
    this.stopped = true;
  }

  async request(action: string, input?: Record<string, unknown>) {
    this.calls.push({ action, input });
    const response = this.responses.shift();
    if (!response) throw new Error('fake controller response missing');
    return response;
  }
}

class PausingRemoveController extends FakeController {
  private releaseRemove!: () => void;
  private markRemoveStarted!: () => void;
  readonly removeStarted = new Promise<void>((resolve) => {
    this.markRemoveStarted = resolve;
  });
  private readonly removeReleased = new Promise<void>((resolve) => {
    this.releaseRemove = resolve;
  });

  continueRemove() {
    this.releaseRemove();
  }

  override async request(action: string, input?: Record<string, unknown>) {
    if (action !== 'remove') return super.request(action, input);
    this.calls.push({ action, input });
    this.markRemoveStarted();
    await this.removeReleased;
    return { state: 'removed' as const, emailAddress: String(input?.emailAddress ?? '') };
  }
}

describe('managed Proton Bridge module', () => {
  let ctx: ReturnType<typeof createTestContext>;

  afterEach(async () => {
    ctx?.cleanup();
  });

  it('persists only generated Bridge credentials after a direct login', async () => {
    ctx = createTestContext();
    const controller = new FakeController();
    controller.responses.push({
      state: 'connected',
      mailbox: {
        emailAddress: 'owner@example.com',
        imapHost: '127.0.0.1',
        imapPort: 1143,
        imapTlsMode: 'starttls',
        smtpHost: '127.0.0.1',
        smtpPort: 1025,
        smtpTlsMode: 'starttls',
        username: 'owner@example.com',
        bridgePassword: 'generated-bridge-password'
      }
    });

    const bridge = new ManagedProtonBridge({
      controller,
      accountService: ctx.accountService,
      available: true,
      version: '3.26.0'
    });
    const result = await bridge.connect({
      emailAddress: 'owner@example.com',
      displayName: 'Owner',
      password: 'proton-account-password'
    });

    expect(result).toMatchObject({ state: 'connected' });
    expect(JSON.stringify(result)).not.toContain('proton-account-password');
    expect(JSON.stringify(result)).not.toContain('generated-bridge-password');

    const account = ctx.db.getEmailAccounts()[0];
    expect(account).toMatchObject({
      provider: 'proton_bridge',
      emailAddress: 'owner@example.com',
      config: { managedBridge: true, imapHost: '127.0.0.1' }
    });
    const secret = ctx.db.getEmailAccountSecret(account.id);
    expect(secret).toBeDefined();
    expect(secret?.encryptedPayload).not.toContain('generated-bridge-password');
    expect(ctx.cryptoService.decrypt(secret!)).toContain('generated-bridge-password');
    expect(ctx.cryptoService.decrypt(secret!)).not.toContain('proton-account-password');
  });

  it('keeps a challenge server-side and completes two-factor login', async () => {
    ctx = createTestContext();
    const controller = new FakeController();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    controller.responses.push(
      {
        state: 'challenge_required',
        challengeId: 'challenge-1',
        challengeType: 'two_factor',
        expiresAt
      },
      {
        state: 'connected',
        mailbox: {
          emailAddress: 'owner@example.com',
          imapHost: '127.0.0.1',
          imapPort: 1143,
          imapTlsMode: 'starttls',
          smtpHost: '127.0.0.1',
          smtpPort: 1025,
          smtpTlsMode: 'starttls',
          username: 'owner@example.com',
          bridgePassword: 'bridge-password'
        }
      }
    );
    const bridge = new ManagedProtonBridge({
      controller,
      accountService: ctx.accountService,
      available: true,
      version: '3.26.0'
    });

    const first = await bridge.connect({
      emailAddress: 'owner@example.com',
      displayName: 'Owner',
      password: 'proton-password'
    });
    expect(first).toEqual({
      state: 'challenge_required',
      challengeId: 'challenge-1',
      challengeType: 'two_factor',
      expiresAt
    });

    const completed = await bridge.continueLogin({
      challengeId: 'challenge-1',
      value: '123456'
    });
    expect(completed).toMatchObject({ state: 'connected' });
    expect(controller.calls.map(({ action }) => action)).toEqual(['connect', 'challenge']);
    expect(controller.calls[1]?.input).toEqual({
      challengeId: 'challenge-1',
      value: '123456'
    });
  });

  it('reports unavailable without starting a controller', async () => {
    ctx = createTestContext();
    const controller = new FakeController();
    const bridge = new ManagedProtonBridge({
      controller,
      accountService: ctx.accountService,
      available: false,
      version: null
    });

    await expect(
      bridge.connect({
        emailAddress: 'owner@example.com',
        displayName: 'Owner',
        password: 'secret-value'
      })
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(controller.started).toBe(false);
  });

  it('syncs split-mode Proton addresses into separate managed accounts', async () => {
    ctx = createTestContext();
    const controller = new FakeController();
    controller.responses.push(
      {
        state: 'connected',
        mailbox: {
          emailAddress: 'owner@pm.me',
          imapHost: '127.0.0.1',
          imapPort: 1143,
          imapTlsMode: 'starttls',
          smtpHost: '127.0.0.1',
          smtpPort: 1025,
          smtpTlsMode: 'starttls',
          username: 'owner@pm.me',
          bridgePassword: 'combined-secret'
        }
      },
      {
        state: 'addresses',
        mode: 'split',
        mailboxes: [
          {
            emailAddress: 'owner@pm.me',
            imapHost: '127.0.0.1',
            imapPort: 1143,
            imapTlsMode: 'starttls',
            smtpHost: '127.0.0.1',
            smtpPort: 1025,
            smtpTlsMode: 'starttls',
            username: 'owner@pm.me',
            bridgePassword: 'owner-split-secret'
          },
          {
            emailAddress: 'clara@clasific.ar',
            imapHost: '127.0.0.1',
            imapPort: 1143,
            imapTlsMode: 'starttls',
            smtpHost: '127.0.0.1',
            smtpPort: 1025,
            smtpTlsMode: 'starttls',
            username: 'clara@clasific.ar',
            bridgePassword: 'clara-split-secret'
          }
        ]
      }
    );
    const bridge = new ManagedProtonBridge({
      controller,
      accountService: ctx.accountService,
      available: true,
      version: '3.26.0'
    });
    const connected = await bridge.connect({
      emailAddress: 'owner@pm.me',
      displayName: 'Owner',
      password: 'proton-secret'
    });
    if (connected.state !== 'connected') throw new Error('expected connection');

    const synced = await bridge.syncAddresses(connected.account.id);
    expect(synced.mode).toBe('split');
    expect(synced.accounts.map(({ emailAddress }) => emailAddress)).toEqual(['owner@pm.me', 'clara@clasific.ar']);
    expect(synced.accounts[1]?.config).toMatchObject({
      managedBridge: true,
      managedBridgeLogin: 'owner@pm.me'
    });
    expect(JSON.stringify(synced)).not.toContain('clara-split-secret');
    const aliasSecret = ctx.db.getEmailAccountSecret(synced.accounts[1]!.id);
    expect(ctx.cryptoService.decrypt(aliasSecret!)).toContain('clara-split-secret');

    ctx.accountService.setEnabled(synced.accounts[1]!.id, false);
    controller.responses.push({
      state: 'addresses',
      mode: 'split',
      mailboxes: [
        {
          emailAddress: 'owner@pm.me',
          imapHost: '127.0.0.1',
          imapPort: 1143,
          imapTlsMode: 'starttls',
          smtpHost: '127.0.0.1',
          smtpPort: 1025,
          smtpTlsMode: 'starttls',
          username: 'owner@pm.me',
          bridgePassword: 'owner-split-secret'
        },
        {
          emailAddress: 'clara@clasific.ar',
          imapHost: '127.0.0.1',
          imapPort: 1143,
          imapTlsMode: 'starttls',
          smtpHost: '127.0.0.1',
          smtpPort: 1025,
          smtpTlsMode: 'starttls',
          username: 'clara@clasific.ar',
          bridgePassword: 'clara-split-secret-2'
        }
      ]
    });
    await bridge.syncAddresses(connected.account.id);
    expect(ctx.accountService.getAccount(synced.accounts[1]!.id).enabled).toBe(false);

    controller.responses.push({
      state: 'addresses',
      mode: 'split',
      mailboxes: [
        {
          emailAddress: 'owner@pm.me',
          imapHost: '127.0.0.1',
          imapPort: 1143,
          imapTlsMode: 'starttls',
          smtpHost: '127.0.0.1',
          smtpPort: 1025,
          smtpTlsMode: 'starttls',
          username: 'owner@pm.me',
          bridgePassword: 'owner-split-secret-2'
        }
      ]
    });
    await bridge.syncAddresses(connected.account.id);
    expect(ctx.accountService.listAccounts().map(({ emailAddress }) => emailAddress)).toEqual(['owner@pm.me']);
  });

  it('does not delete a managed Proton group while any sender is assigned', async () => {
    ctx = createTestContext();
    const controller = new FakeController();
    const primary = ctx.accountService.upsertManagedProtonBridgeAccount({
      emailAddress: 'owner@pm.me',
      displayName: 'Owner',
      imapHost: '127.0.0.1',
      imapPort: 1143,
      imapTlsMode: 'starttls',
      smtpHost: '127.0.0.1',
      smtpPort: 1025,
      smtpTlsMode: 'starttls',
      username: 'owner@pm.me',
      password: 'owner-secret',
      managedBridgeLogin: 'owner@pm.me'
    });
    const alias = ctx.accountService.upsertManagedProtonBridgeAccount({
      emailAddress: 'clara@clasific.ar',
      displayName: 'Clara',
      imapHost: '127.0.0.1',
      imapPort: 1143,
      imapTlsMode: 'starttls',
      smtpHost: '127.0.0.1',
      smtpPort: 1025,
      smtpTlsMode: 'starttls',
      username: 'clara@clasific.ar',
      password: 'alias-secret',
      managedBridgeLogin: 'owner@pm.me'
    });
    ctx.accessProfileService.create({
      name: 'clara',
      readEnabled: true,
      draftEnabled: false,
      sendEnabled: true,
      accountIds: [alias.id]
    });
    const bridge = new ManagedProtonBridge({
      controller,
      accountService: ctx.accountService,
      available: true,
      version: '3.26.0'
    });

    controller.responses.push({
      state: 'addresses',
      mode: 'split',
      mailboxes: [
        {
          emailAddress: 'owner@pm.me',
          imapHost: '127.0.0.1',
          imapPort: 1143,
          imapTlsMode: 'starttls',
          smtpHost: '127.0.0.1',
          smtpPort: 1025,
          smtpTlsMode: 'starttls',
          username: 'owner@pm.me',
          bridgePassword: 'owner-secret-2'
        }
      ]
    });
    await expect(bridge.syncAddresses(primary.id)).rejects.toMatchObject({
      code: 'ACCOUNT_IN_USE'
    });
    expect(ctx.accountService.listAccounts()).toHaveLength(2);
    expect(ctx.accountService.getAccount(alias.id).enabled).toBe(false);
    const refreshedPrimarySecret = ctx.db.getEmailAccountSecret(primary.id);
    expect(ctx.cryptoService.decrypt(refreshedPrimarySecret!)).toContain('owner-secret-2');

    await expect(bridge.disconnectAccount(primary.id)).rejects.toMatchObject({
      code: 'ACCOUNT_IN_USE'
    });
    expect(controller.calls.some(({ action }) => action === 'remove')).toBe(false);
    expect(ctx.accountService.listAccounts()).toHaveLength(2);
  });

  it('preserves a Proton group when an alias is assigned during Bridge removal', async () => {
    ctx = createTestContext();
    const controller = new PausingRemoveController();
    const createManaged = (emailAddress: string) =>
      ctx.accountService.upsertManagedProtonBridgeAccount({
        emailAddress,
        displayName: emailAddress,
        imapHost: '127.0.0.1',
        imapPort: 1143,
        imapTlsMode: 'starttls',
        smtpHost: '127.0.0.1',
        smtpPort: 1025,
        smtpTlsMode: 'starttls',
        username: emailAddress,
        password: `${emailAddress}-secret`,
        managedBridgeLogin: 'owner@pm.me'
      });
    const primary = createManaged('owner@pm.me');
    const alias = createManaged('clara@clasific.ar');
    const bridge = new ManagedProtonBridge({
      controller,
      accountService: ctx.accountService,
      available: true,
      version: '3.26.0'
    });

    const deletion = bridge.disconnectAccount(primary.id);
    await controller.removeStarted;
    ctx.accessProfileService.create({
      name: 'late-assignment',
      readEnabled: true,
      draftEnabled: false,
      sendEnabled: true,
      accountIds: [alias.id]
    });
    controller.continueRemove();

    await expect(deletion).rejects.toMatchObject({ code: 'ACCOUNT_IN_USE' });
    expect(ctx.accountService.listAccounts()).toHaveLength(2);
    expect(ctx.accessProfileService.list()[0]?.accountIds).toContain(alias.id);
  });

  it('reports an available stopped provider without paying startup cost', async () => {
    ctx = createTestContext();
    const controller = new FakeController();
    const bridge = new ManagedProtonBridge({
      controller,
      accountService: ctx.accountService,
      available: true,
      version: '3.26.0'
    });

    await expect(bridge.status()).resolves.toEqual({
      available: true,
      version: '3.26.0',
      state: 'stopped',
      accounts: []
    });
    expect(controller.started).toBe(false);
    expect(controller.calls).toEqual([]);
  });
});
