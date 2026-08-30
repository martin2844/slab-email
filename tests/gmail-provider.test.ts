import { describe, expect, it } from 'vitest';

import { formatProviderError } from '../src/providers/gmail/provider.js';

describe('Gmail send outcome classification', () => {
  it('keeps transport and server failures ambiguous', () => {
    expect(formatProviderError(new Error('connection reset'))).toMatchObject({
      status: 'unknown'
    });
    expect(formatProviderError({
      response: { status: 503, data: { error: { message: 'backend unavailable' } } }
    })).toEqual({ status: 'unknown', detail: 'backend unavailable' });
  });

  it('marks an authoritative request rejection as failed', () => {
    expect(formatProviderError({
      response: { status: 403, data: { error: { message: 'insufficient scope' } } }
    })).toEqual({ status: 'failed', detail: 'insufficient scope' });
  });
});
