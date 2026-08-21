import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';

import { PythonProtonBridgeController } from '../src/proton/controller.js';

type Envelope = {
  id: string | null;
  ok: boolean;
  event?: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
};

const fakeBridge = `#!/usr/bin/env python3
import getpass
import sys

def read_command():
    # Proton Bridge's ishell prompt is redrawn with terminal cursor controls.
    sys.stdout.write("\\r\\b\\r\\b\\r\\b\\r\\b>>>  \\b")
    sys.stdout.flush()
    return input().strip()

accounts = []
while True:
    try:
        command = read_command()
    except (EOFError, KeyboardInterrupt):
        break
    if command == "telemetry disable":
        print("Usage diagnostics collection is disabled.")
    elif command == "updates autoupdates disable":
        input("Are you sure you want to stop bridge from doing this? yes/no: ")
        print("Automatic updates are disabled.")
    elif command == "list":
        for index, email in enumerate(accounts):
            print(f"{index}: {email:<20} (connected      , combined       )")
    elif command == "login":
        email = input("Username: ")
        getpass.getpass("Password: ")
        if "+hv" in email:
            print("Human Verification requested. Please open the URL below in a browser and press ENTER when the challenge has been completed.")
            print("https://verify.proton.me/challenge/test-token")
            input()
        elif "+2fa" in email:
            input("Two factor code: ")
        accounts.append(email)
        print(f"Account {email} was added successfully.")
    elif command.startswith("info "):
        email = command.split(" ", 1)[1]
        print(f"Configuration for {email}")
        print("IMAP Settings")
        print("Address:   127.0.0.1")
        print("IMAP port: 1143")
        print(f"Username:  {email}")
        print("Password:  generated-bridge-secret")
        print("Security:  STARTTLS")
        print("")
        print("SMTP Settings")
        print("Address:   127.0.0.1")
        print("SMTP port: 1025")
        print(f"Username:  {email}")
        print("Password:  generated-bridge-secret")
        print("Security:  STARTTLS")
    elif command.startswith("delete "):
        email = command.split(" ", 1)[1]
        answer = input(f"Are you sure you want to remove account {email}? yes/no: ")
        if answer.lower().startswith("y") and email in accounts:
            accounts.remove(email)
`;

describe('Proton Bridge private controller protocol', () => {
  const directories: string[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];

  afterEach(() => {
    for (const child of children) child.kill('SIGKILL');
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  });

  it('handles password and two-factor input without returning either secret', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'slab-proton-controller-'));
    directories.push(directory);
    const bin = join(directory, 'bin');
    const bridge = join(directory, 'fake-bridge');
    const gpg = join(bin, 'gpg');
    const pass = join(bin, 'pass');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(bin));
    writeFileSync(bridge, fakeBridge, { mode: 0o700 });
    writeFileSync(
      gpg,
      '#!/bin/sh\ncase "$*" in *--list-secret-keys*) printf "fpr:::::::::TESTFINGERPRINT:\\n";; esac\nexit 0\n',
      { mode: 0o700 }
    );
    writeFileSync(pass, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    chmodSync(bridge, 0o700);

    const controller = spawn(
      'python3',
      [
        resolve('src/proton/bridge_controller.py'),
        '--bridge',
        bridge,
        '--data-dir',
        join(directory, 'data')
      ],
      {
        cwd: process.cwd(),
        env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, LANG: 'C.UTF-8' },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );
    children.push(controller);
    const next = lineReader(controller);
    expect(await next('ready')).toMatchObject({ id: null, ok: true, event: 'ready' });

    controller.stdin.write(
      `${JSON.stringify({
        id: 'connect-1',
        action: 'connect',
        emailAddress: 'owner+2fa@example.com',
        password: 'proton-account-secret'
      })}\n`
    );
    const challenge = await next('challenge');
    expect(challenge).toMatchObject({
      id: 'connect-1',
      ok: true,
      result: { state: 'challenge_required', challengeType: 'two_factor' }
    });
    const challengeId = String(challenge.result?.challengeId);

    controller.stdin.write(
      `${JSON.stringify({
        id: 'challenge-1',
        action: 'challenge',
        challengeId,
        value: '123456'
      })}\n`
    );
    const connected = await next('connected');
    expect(connected).toMatchObject({
      id: 'challenge-1',
      ok: true,
      result: {
        state: 'connected',
        mailbox: {
          emailAddress: 'owner+2fa@example.com',
          bridgePassword: 'generated-bridge-secret'
        }
      }
    });
    const serialized = JSON.stringify([challenge, connected]);
    expect(serialized).not.toContain('proton-account-secret');
    expect(serialized).not.toContain('123456');

    controller.stdin.write(
      `${JSON.stringify({
        id: 'connect-2',
        action: 'connect',
        emailAddress: 'owner+hv@example.com',
        password: 'second-proton-secret'
      })}\n`
    );
    const verification = await next('human verification');
    expect(verification.ok, JSON.stringify(verification)).toBe(true);
    expect(verification).toMatchObject({
      id: 'connect-2',
      ok: true,
      result: {
        state: 'challenge_required',
        challengeType: 'human_verification',
        verificationUrl: 'https://verify.proton.me/challenge/test-token'
      }
    });
    controller.stdin.write(
      `${JSON.stringify({
        id: 'challenge-2',
        action: 'challenge',
        challengeId: String(verification.result?.challengeId),
        value: ''
      })}\n`
    );
    const verified = await next('human verified');
    expect(verified).toMatchObject({
      id: 'challenge-2',
      ok: true,
      result: { state: 'connected', mailbox: { emailAddress: 'owner+hv@example.com' } }
    });
    expect(JSON.stringify([verification, verified])).not.toContain('second-proton-secret');
  }, 20_000);

  it('makes concurrent callers wait for the same controller startup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'slab-proton-start-'));
    directories.push(directory);
    const controllerScript = join(directory, 'delayed-controller.py');
    writeFileSync(
      controllerScript,
      `#!/usr/bin/env python3
import json
import sys
import time

time.sleep(0.15)
print(json.dumps({"id": None, "ok": True, "event": "ready"}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    print(json.dumps({"id": request["id"], "ok": True, "result": {"state": "ready", "accounts": []}}), flush=True)
`,
      { mode: 0o700 }
    );
    const controller = new PythonProtonBridgeController({
      pythonBinary: 'python3',
      controllerScript,
      bridgeBinary: '/unused',
      dataDirectory: join(directory, 'data'),
      startTimeoutMs: 2_000
    });

    const first = controller.start();
    let secondResolved = false;
    const second = controller.start().then(() => {
      secondResolved = true;
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    expect(secondResolved).toBe(false);
    await Promise.all([first, second]);
    await expect(controller.request('status')).resolves.toMatchObject({ state: 'ready' });
    await controller.stop();
  });
});

function lineReader(child: ChildProcessWithoutNullStreams) {
  const lines: Envelope[] = [];
  const waiters: Array<(value: Envelope) => void> = [];
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2_000);
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const value = JSON.parse(line) as Envelope;
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else lines.push(value);
  });
  return (label = 'response') =>
    new Promise<Envelope>((resolvePromise, reject) => {
      const existing = lines.shift();
      if (existing) {
        resolvePromise(existing);
        return;
      }
      const timeout = setTimeout(
        () => reject(new Error(`${label} timed out: ${stderr || 'no stderr'}`)),
        10_000
      );
      waiters.push((value) => {
        clearTimeout(timeout);
        resolvePromise(value);
      });
    });
}
