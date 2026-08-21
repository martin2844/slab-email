import { afterEach, describe, expect, it } from 'vitest';

import {
  ManagedProtonBridge,
  type ProtonBridgeController,
  type ProtonBridgeControllerResult
} from '../src/services/proton-bridge-manager.js';
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
    expect(controller.calls.map(({ action }) => action)).toEqual([
      'connect',
      'challenge'
    ]);
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

    await expect(bridge.connect({
      emailAddress: 'owner@example.com',
      displayName: 'Owner',
      password: 'secret-value'
    })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(controller.started).toBe(false);
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
