/* global AbortSignal, fetch */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

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

const hiddenQuestion = (
  _readline: ReturnType<typeof createInterface>,
  label: string
): string => {
  if (!stdin.isTTY) throw new Error('A TTY is required for secret input.');
  stdout.write(label);
  return execFileSync(
    '/bin/sh',
    [
      '-c',
      "trap 'stty echo </dev/tty' EXIT HUP INT TERM; stty -echo </dev/tty; IFS= read -r value </dev/tty; printf '\\n' >/dev/tty; printf '%s' \"$value\""
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  );
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

  const readline = createInterface({ input: stdin, output: stdout });
  let challengeId: string | null = null;
  try {
    stdout.write(`\nManaged Proton Bridge ${status.version ? `v${status.version}` : ''}\n`);
    stdout.write('Login values are sent directly to Bridge and are never stored.\n\n');
    const emailAddress = (await readline.question('Proton email: ')).trim();
    const displayName = (await readline.question('Display name: ')).trim();
    const password = await hiddenQuestion(readline, 'Proton password: ');
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
        await readline.question('Complete Proton verification, then press Enter.');
      } else {
        const label = result.challengeType === 'two_factor'
          ? 'Two-factor code: '
          : 'Mailbox password: ';
        value = await hiddenQuestion(readline, label);
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
    readline.close();
  }
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Managed Proton Bridge setup failed.';
  process.stderr.write(`Proton Bridge setup failed: ${message.replace(/[\r\n\t]+/g, ' ').slice(0, 300)}\n`);
  process.exitCode = 1;
});
