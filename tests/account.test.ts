import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import { createTestContext } from './helpers.js';

const adminHeaders = (adminKey: string) => ({
  Authorization: `Bearer ${adminKey}`
});

const baseProtonPayload = {
  emailAddress: 'martin@clasific.ar',
  displayName: 'Martin',
  imapHost: '127.0.0.1',
  imapPort: 1143,
  imapTlsMode: 'ssl' as const,
  smtpHost: '127.0.0.1',
  smtpPort: 1025,
  smtpTlsMode: 'starttls' as const,
  username: 'bridge-user',
  password: 'bridge-pass'
};

describe('account service endpoints', () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('creates proton bridge account and stores credentials encrypted', async () => {
    const res = await request(ctx.app)
      .post('/api/accounts/proton-bridge')
      .set(adminHeaders(ctx.config.adminKey))
      .send(baseProtonPayload)
      .expect(201);

    expect(res.body).toMatchObject({
      emailAddress: baseProtonPayload.emailAddress,
      provider: 'proton_bridge',
      displayName: baseProtonPayload.displayName,
      enabled: true
    });
    expect(JSON.stringify(res.body)).not.toContain(baseProtonPayload.password);

    const secret = ctx.db.getEmailAccountSecret(res.body.id);
    expect(secret).toBeDefined();
    expect(secret?.encryptedPayload).toBeDefined();
    if (!secret) throw new Error('secret row missing');

    const clear = JSON.parse(ctx.cryptoService.decrypt(secret));
    expect(clear).toMatchObject({
      username: baseProtonPayload.username,
      password: baseProtonPayload.password
    });
  });

  it('does not expose secrets in account read/update responses', async () => {
    const create = await request(ctx.app)
      .post('/api/accounts/proton-bridge')
      .set(adminHeaders(ctx.config.adminKey))
      .send(baseProtonPayload)
      .expect(201);

    const id = create.body.id;
    const read = await request(ctx.app)
      .get(`/api/accounts/${id}`)
      .set(adminHeaders(ctx.config.adminKey))
      .expect(200);

    expect(read.body).not.toHaveProperty('password');
    expect(read.body).not.toHaveProperty('refreshToken');
    expect(read.body).not.toHaveProperty('secret');
    expect(read.text).not.toContain(baseProtonPayload.password);

    const update = await request(ctx.app)
      .post(`/api/accounts/${id}`)
      .set(adminHeaders(ctx.config.adminKey))
      .send({
        displayName: 'Martin New'
      })
      .expect(200);
    expect(update.body.displayName).toBe('Martin New');
  });

  it('supports account lifecycle operations', async () => {
    const created = await request(ctx.app)
      .post('/api/accounts/imap-smtp')
      .set(adminHeaders(ctx.config.adminKey))
      .send({
        ...baseProtonPayload,
        imapPort: 1993,
        smtpPort: 2025,
        imapTlsMode: 'none',
        smtpTlsMode: 'none'
      })
      .expect(201);

    const id = created.body.id;
    await request(ctx.app).post(`/api/accounts/${id}/disable`).set(adminHeaders(ctx.config.adminKey)).expect(200);
    await request(ctx.app).post(`/api/accounts/${id}/test`).set(adminHeaders(ctx.config.adminKey)).expect(409);

    await request(ctx.app).post(`/api/accounts/${id}/enable`).set(adminHeaders(ctx.config.adminKey)).expect(200);

    const removed = await request(ctx.app).delete(`/api/accounts/${id}`).set(adminHeaders(ctx.config.adminKey));
    expect(removed.status).toBe(204);
    await request(ctx.app).get(`/api/accounts/${id}`).set(adminHeaders(ctx.config.adminKey)).expect(404);
  });

  it('validates test result endpoint uses provider verification', async () => {
    const account = await request(ctx.app)
      .post('/api/accounts/proton-bridge')
      .set(adminHeaders(ctx.config.adminKey))
      .send(baseProtonPayload)
      .expect(201);

    const verifySpy = vi
      .spyOn(ctx.accountService, 'getProviderForAccount')
      .mockResolvedValueOnce({
        verifyConnection: async () => ({
          status: 'ok',
          latencyMs: 1,
          providerMessage: 'ok'
        })
      } as never);

    const testCall = await request(ctx.app).post(`/api/accounts/${account.body.id}/test`).set(adminHeaders(ctx.config.adminKey));
    expect(testCall.status).toBe(200);
    expect(testCall.body).toMatchObject({
      status: 'ok',
      provider: 'proton_bridge'
    });
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });
});
