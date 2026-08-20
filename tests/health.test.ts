import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createTestContext } from './helpers.js';

describe('health contracts', () => {
  it('keeps liveness public and reports schema readiness', async () => {
    const context = createTestContext();
    try {
      await request(context.app).get('/health').expect(200, { status: 'ok' });
      const ready = await request(context.app).get('/ready').expect(200);
      expect(ready.body).toMatchObject({
        status: 'ready',
        database: 'ok',
        migrations: { ready: true, applied: [1, 2], pending: [] }
      });
    } finally {
      context.cleanup();
    }
  });
});
