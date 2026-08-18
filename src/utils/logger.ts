type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug'];

const redactedKeys = new Set([
  'password',
  'secret',
  'token',
  'authorization',
  'auth',
  'refreshToken',
  'refresh_token',
  'connectorToken',
  'adminKey',
  'slab_email_admin_key',
  'slab_email_master_key'
]);

const redactValue = (value: unknown): unknown => {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (redactedKeys.has(key) || key.toLowerCase().includes('password') || key.toLowerCase().includes('token')) {
        output[key] = '[redacted]';
      } else {
        output[key] = redactValue(entry);
      }
    }
    return output;
  }
  return value;
};

export class Logger {
  constructor(private readonly level: LogLevel = 'info') {}

  private shouldLog(level: LogLevel): boolean {
    return LEVELS.indexOf(level) <= LEVELS.indexOf(this.level);
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) {
      return;
    }
    const redactedMeta = redactValue(meta ?? {});
    const safeMeta =
      redactedMeta && typeof redactedMeta === 'object' && !Array.isArray(redactedMeta)
        ? redactedMeta
        : { meta: redactedMeta };
    const payload = JSON.stringify(
      {
        level,
        message,
        ...(safeMeta as Record<string, unknown>),
        timestamp: new Date().toISOString()
      },
      null,
      2
    );
    process.stdout.write(`${payload}\n`);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }
}
