/* global AbortSignal, fetch */
import { readFileSync } from 'node:fs';
import { stdout } from 'node:process';

import { hiddenInputLabel } from './setup-prompts.js';
import { terminalQuestion } from './terminal-question.js';

type SetupResult =
  | {
      state: 'challenge_required';
      challengeId: string;
      challengeType: 'two_factor' | 'mailbox_password' | 'human_verification';
      verificationUrl?: string;
    }
  | { state: 'connected'; account: { emailAddress: string; displayName: string } };

const adminKey = (): string => {
  const direct = process.env.SLAB_EMAIL_ADMIN_KEY?.trim();
  const path = process.env.SLAB_EMAIL_ADMIN_KEY_FILE?.trim();
  if (direct && path) throw new Error('Email admin authentication is ambiguous.');
  const value = direct || (path ? readFileSync(path, 'utf8').trim() : '');
  if (!value) throw new Error('Email admin authentication is not configured.');
  return value;
};

const request = async <T>(path: string, body?: unknown): Promise<T> => {
  const port = process.env.PORT?.trim() || '6981';
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${adminKey()}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000)
  });
  const payload = (await response.json().catch(() => null)) as
    | T
    | { error?: { message?: string } }
    | null;
  if (!response.ok) {
    throw new Error(
      payload && typeof payload === 'object' && 'error' in payload && payload.error?.message
        ? payload.error.message
        : `slab-email returned HTTP ${response.status}.`
    );
  }
  return payload as T;
};

const main = async (): Promise<void> => {
  const status = await request<{
    available: boolean;
    version: string | null;
    state: string;
    accounts: Array<{ emailAddress: string }>;
  }>('/api/proton-bridge');
  if (process.argv.includes('--configured')) {
    process.exitCode = status.available && status.accounts.length > 0 ? 0 : 1;
    return;
  }
  if (!status.available) {
    throw new Error('Managed Proton Bridge is not available in this image/platform.');
  }
  if (process.argv.includes('--status')) {
    stdout.write(
      `Managed Proton Bridge ${status.version ? `v${status.version}` : ''}: ${status.state}; ${status.accounts.length} account(s).\n`
    );
    return;
  }

  let challengeId: string | null = null;
  try {
    stdout.write(`\nManaged Proton Bridge ${status.version ? `v${status.version}` : ''}\n`);
    stdout.write('Login values are sent directly to Bridge and are never stored.\n\n');
    const emailAddress = terminalQuestion('Proton email: ').trim();
    const displayName = terminalQuestion('Display name: ').trim();
    const password = terminalQuestion(hiddenInputLabel('Proton password'), true);
    let result = await request<SetupResult>('/api/proton-bridge/connect', {
      emailAddress,
      displayName,
      password
    });

    while (result.state === 'challenge_required') {
      challengeId = result.challengeId;
      let value: string | undefined;
      if (result.challengeType === 'human_verification') {
        if (result.verificationUrl) stdout.write(`Open: ${result.verificationUrl}\n`);
        terminalQuestion('Complete Proton verification, then press Enter.');
      } else {
        const label = result.challengeType === 'two_factor'
          ? hiddenInputLabel('Two-factor code')
          : hiddenInputLabel('Mailbox password');
        value = terminalQuestion(label, true);
      }
      result = await request<SetupResult>('/api/proton-bridge/challenge', {
        challengeId: result.challengeId,
        ...(value === undefined ? {} : { value })
      });
    }

    challengeId = null;
    stdout.write(`Connected ${result.account.emailAddress}.\n`);
  } finally {
    if (challengeId) {
      await request('/api/proton-bridge/abort', { challengeId }).catch(() => undefined);
    }
  }
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Managed Proton Bridge setup failed.';
  process.stderr.write(`Proton Bridge setup failed: ${message.replace(/[\r\n\t]+/g, ' ').slice(0, 300)}\n`);
  process.exitCode = 1;
});
