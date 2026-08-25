import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { clearTimeout, setTimeout } from 'node:timers';

import type {
  ProtonBridgeController,
  ProtonBridgeControllerResult
} from '../services/proton-bridge-manager.js';

type ControllerEnvelope = {
  id: string | null;
  ok: boolean;
  event?: string;
  result?: ProtonBridgeControllerResult;
  error?: { code?: string; message?: string };
};

type PendingCall = {
  resolve: (result: ProtonBridgeControllerResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type PythonProtonBridgeControllerOptions = {
  pythonBinary: string;
  controllerScript: string;
  bridgeBinary: string;
  dataDirectory: string;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
};

export class PythonProtonBridgeController implements ProtonBridgeController {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private startPromise: Promise<void> | null = null;
  private startResolve: (() => void) | null = null;
  private startReject: ((error: Error) => void) | null = null;
  private stderrTail = '';
  private stopping = false;

  constructor(private readonly options: PythonProtonBridgeControllerOptions) {}

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.child && !this.child.killed) return;
    this.stopping = false;
    this.stderrTail = '';
    const child = spawn(
      this.options.pythonBinary,
      [
        this.options.controllerScript,
        '--bridge',
        this.options.bridgeBinary,
        '--data-dir',
        this.options.dataDirectory
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          LANG: process.env.LANG ?? 'C.UTF-8',
          LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
          TERM: 'xterm-256color'
        }
      }
    );
    this.child = child;
    const reader = createInterface({ input: child.stdout });
    reader.on('line', (line) => this.onLine(line));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-4_096);
    });
    child.once('exit', (code, signal) => {
      reader.close();
      this.child = null;
      const message = this.stopping
        ? 'Managed Proton Bridge stopped.'
        : `Managed Proton Bridge controller exited (${signal ?? code ?? 'unknown'}).`;
      const error = new Error(message);
      this.startReject?.(error);
      this.clearStart();
      for (const call of this.pending.values()) {
        clearTimeout(call.timeout);
        call.reject(error);
      }
      this.pending.clear();
    });
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
      setTimeout(() => {
        if (!this.startReject) return;
        const error = new Error('Managed Proton Bridge did not become ready in time.');
        this.startReject(error);
        this.clearStart();
        child.kill('SIGTERM');
      }, this.options.startTimeoutMs ?? 45_000).unref();
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5_000);
      force.unref();
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  async request(
    action: string,
    input: Record<string, unknown> = {}
  ): Promise<ProtonBridgeControllerResult> {
    await this.start();
    const child = this.child;
    if (!child || child.killed) throw new Error('Managed Proton Bridge is not running.');
    const id = randomUUID();
    return new Promise<ProtonBridgeControllerResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Managed Proton Bridge ${action} request timed out.`));
      }, this.options.requestTimeoutMs ?? (action === 'addresses' ? 180_000 : 60_000));
      timeout.unref();
      this.pending.set(id, { resolve, reject, timeout });
      child.stdin.write(`${JSON.stringify({ id, action, ...input })}\n`);
    });
  }

  private onLine(line: string): void {
    let envelope: ControllerEnvelope;
    try {
      envelope = JSON.parse(line) as ControllerEnvelope;
    } catch {
      return;
    }
    if (envelope.id === null && envelope.event === 'ready' && envelope.ok) {
      this.startResolve?.();
      this.clearStart();
      return;
    }
    if (!envelope.id) return;
    const call = this.pending.get(envelope.id);
    if (!call) return;
    this.pending.delete(envelope.id);
    clearTimeout(call.timeout);
    if (!envelope.ok || !envelope.result) {
      const code = envelope.error?.code?.replace(/[^A-Z0-9_]/g, '').slice(0, 80);
      const message = sanitizeControllerMessage(envelope.error?.message);
      call.reject(new Error(`${code ? `${code}: ` : ''}${message}`));
      return;
    }
    call.resolve(envelope.result);
  }

  private clearStart(): void {
    this.startPromise = null;
    this.startResolve = null;
    this.startReject = null;
  }
}

const sanitizeControllerMessage = (value: unknown): string => {
  if (typeof value !== 'string') return 'Managed Proton Bridge request failed.';
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300) ||
    'Managed Proton Bridge request failed.';
};
