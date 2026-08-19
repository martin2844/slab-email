import { describe, expect, it } from 'vitest';

import { shouldTrustDockerDesktopBridge } from '../src/providers/factory.js';

describe('Docker Desktop Proton Bridge relay', () => {
  it('trusts only the explicit Docker relay for Proton Bridge', () => {
    expect(
      shouldTrustDockerDesktopBridge(
        'proton_bridge',
        'host.docker.internal',
        'host.docker.internal'
      )
    ).toBe(true);
    expect(
      shouldTrustDockerDesktopBridge(
        'imap_smtp',
        'host.docker.internal',
        'host.docker.internal'
      )
    ).toBe(false);
    expect(
      shouldTrustDockerDesktopBridge(
        'proton_bridge',
        'mail.example.com',
        'mail.example.com'
      )
    ).toBe(false);
  });
});
