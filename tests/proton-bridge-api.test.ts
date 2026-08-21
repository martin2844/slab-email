import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { ManagedProtonBridge, type ProtonBridgeController, type ProtonBridgeControllerResult } from '../src/services/proton-bridge-manager.js';
import { createTestContext, type TestContext } from './helpers.js';

class FakeController implements ProtonBridgeController {
  started = false;
  requests: Array<{ action: string; input?: Record<string, unknown> }> = [];

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async request(action: string, input?: Record<string, unknown>): Promise<ProtonBridgeControllerResult> {
    this.requests.push({ action, input });
    if (action === 'status') return { state: 'ready', accounts: [] };
    if (action === 'connect') {
      return {
        state: 'challenge_required',
        challengeId: '40a8f8ff-40d1-46e0-81bb-02c34a185864',
        challengeType: 'two_factor',
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      };
    }
    if (action === 'challenge') {
      return {
        state: 'connected',
        mailbox: {
          emailAddress: 'operator@proton.me',
          imapHost: '127.0.0.1',
          imapPort: 1143,
          imapTlsMode: 'starttls',
          smtpHost: '127.0.0.1',
          smtpPort: 1025,
          smtpTlsMode: 'starttls',
          username: 'bridge-user',
          bridgePassword: 'bridge-generated-secret'
        }
      };
    }
    if (action === 'remove') return { state: 'removed', emailAddress: 'operator@proton.me' };
    return { state: 'aborted' };
  }
}

describe('managed Proton Bridge admin API', () => {
  let ctx: TestContext | undefined;
  let controller: FakeController;

  afterEach(async () => {
    await ctx?.managedProtonBridge?.shutdown();
    ctx?.cleanup();
    ctx = undefined;
  });

  const setup = () => {
    controller = new FakeController();
    ctx = createTestContext({}, {
      managedProtonBridgeFactory: (accountService) => new ManagedProtonBridge({
        controller,
        accountService,
        available: true,
        version: '3.26.0'
      })
    });
    return ctx;
  };

  it('requires admin authentication', async () => {
    const test = setup();
    await request(test.app).get('/api/proton-bridge').expect(401);
    await request(test.app).post('/api/proton-bridge/connect').send({}).expect(401);
  });

  it('completes a challenge without returning either credential', async () => {
    const test = setup();
    const auth = { Authorization: `Bearer ${test.config.adminKey}` };
    const started = await request(test.app)
      .post('/api/proton-bridge/connect')
      .set(auth)
      .send({
        emailAddress: 'operator@proton.me',
        displayName: 'Operator',
        password: 'proton-login-secret'
      })
      .expect(200);
    expect(started.body).toMatchObject({
      state: 'challenge_required',
      challengeType: 'two_factor'
    });

    const connected = await request(test.app)
      .post('/api/proton-bridge/challenge')
      .set(auth)
      .send({ challengeId: started.body.challengeId, value: '123456' })
      .expect(200);
    const serialized = JSON.stringify(connected.body);
    expect(connected.body).toMatchObject({
      state: 'connected',
      account: { provider: 'proton_bridge', emailAddress: 'operator@proton.me' }
    });
    expect(serialized).not.toContain('proton-login-secret');
    expect(serialized).not.toContain('bridge-generated-secret');
    expect(serialized).not.toContain('bridge-user');
    expect(controller.requests).toContainEqual({
      action: 'challenge',
      input: { challengeId: started.body.challengeId, value: '123456' }
    });
  });

  it('removes a managed account from Bridge and local persistence', async () => {
    const test = setup();
    const account = test.accountService.upsertManagedProtonBridgeAccount({
      emailAddress: 'operator@proton.me',
      displayName: 'Operator',
      imapHost: '127.0.0.1',
      imapPort: 1143,
      imapTlsMode: 'starttls',
      smtpHost: '127.0.0.1',
      smtpPort: 1025,
      smtpTlsMode: 'starttls',
      username: 'bridge-user',
      password: 'bridge-generated-secret'
    });
    await request(test.app)
      .delete(`/api/proton-bridge/accounts/${account.id}`)
      .set('Authorization', `Bearer ${test.config.adminKey}`)
      .expect(204);
    expect(test.accountService.listAccounts()).toEqual([]);
    expect(controller.requests).toContainEqual({
      action: 'remove',
      input: { emailAddress: 'operator@proton.me' }
    });
  });
});
