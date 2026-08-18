import 'dotenv/config';
import crypto from 'node:crypto';
import { z } from 'zod';

const parseCsv = (value: unknown): string[] =>
  String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().trim().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(6981),
  DATABASE_PATH: z.string().trim().default('./data/slab-email.db'),
  SLAB_EMAIL_ADMIN_KEY: z.string().trim().min(1, 'SLAB_EMAIL_ADMIN_KEY is required'),
  SLAB_EMAIL_MASTER_KEY: z.string().trim().min(1, 'SLAB_EMAIL_MASTER_KEY is required'),
  GOOGLE_CLIENT_ID: z.string().trim().default(''),
  GOOGLE_CLIENT_SECRET: z.string().trim().default(''),
  GOOGLE_REDIRECT_URI: z
    .string()
    .trim()
    .url('Invalid GOOGLE_REDIRECT_URI')
    .default('http://127.0.0.1:6981/api/oauth/google/callback'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  MAX_SENDS_PER_ACCOUNT_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(60),
  MCP_ALLOWED_ORIGINS: z.preprocess(parseCsv, z.array(z.string()).default(['127.0.0.1:6981'])),
  MCP_ALLOWED_ORIGINS_HOSTS: z
    .preprocess(parseCsv, z.array(z.string()).default(['127.0.0.1', '[::1]', 'localhost'])),
  PUBLIC_ADMIN_ALLOWED_ORIGINS: z.preprocess(
    parseCsv,
    z.array(z.string()).default(['127.0.0.1:6981', 'localhost:6981'])
  ),
  NODE_ENV_ALLOW_INSECURE_LOCAL: z.preprocess(
    (value) => String(value || '').toLowerCase() === 'true',
    z.boolean().default(false)
  ),
  SMTP_MESSAGE_ID_DOMAIN: z.string().trim().optional(),
  GMAIL_SCOPE_READ: z
    .string()
    .trim()
    .default('https://www.googleapis.com/auth/gmail.readonly'),
  GMAIL_SCOPE_COMPOSE: z
    .string()
    .trim()
    .default('https://www.googleapis.com/auth/gmail.compose'),
  GMAIL_SCOPE_SEND: z
    .string()
    .trim()
    .default('https://www.googleapis.com/auth/gmail.send'),
  GMAIL_TOKEN_REFRESH_WINDOW_SECONDS: z.coerce.number().int().min(60).default(300),
});

export interface RuntimeConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databasePath: string;
  adminKey: string;
  masterKey: Buffer;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  maxSendsPerAccountPerHour: number;
  mcpAllowedOrigins: string[];
  mcpAllowedHostnames: string[];
  publicAdminAllowedOrigins: string[];
  allowInsecureLoopback: boolean;
  smtpMessageIdDomain?: string;
  gmailScopes: string[];
}

const parseMasterKey = (raw: string): Buffer => {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  const base64Value = raw.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/=]+$/.test(base64Value)) {
    const decoded = Buffer.from(base64Value, 'base64');
    if (decoded.length === 32) {
      return decoded;
    }
  }

  throw new Error(
    'SLAB_EMAIL_MASTER_KEY must be 64 hex chars (32 bytes) or base64 string with 32 decoded bytes'
  );
};

export const loadConfig = (): RuntimeConfig => {
  const parsed = envSchema.parse(process.env);
  const gmailScopes = [parsed.GMAIL_SCOPE_READ, parsed.GMAIL_SCOPE_COMPOSE, parsed.GMAIL_SCOPE_SEND];
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    databasePath: parsed.DATABASE_PATH,
    adminKey: parsed.SLAB_EMAIL_ADMIN_KEY,
    masterKey: parseMasterKey(parsed.SLAB_EMAIL_MASTER_KEY),
    googleClientId: parsed.GOOGLE_CLIENT_ID,
    googleClientSecret: parsed.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: parsed.GOOGLE_REDIRECT_URI,
    logLevel: parsed.LOG_LEVEL,
    maxSendsPerAccountPerHour: parsed.MAX_SENDS_PER_ACCOUNT_PER_HOUR,
    mcpAllowedOrigins: parsed.MCP_ALLOWED_ORIGINS,
    mcpAllowedHostnames: parsed.MCP_ALLOWED_ORIGINS_HOSTS,
    publicAdminAllowedOrigins: parsed.PUBLIC_ADMIN_ALLOWED_ORIGINS,
    allowInsecureLoopback: parsed.NODE_ENV_ALLOW_INSECURE_LOCAL,
    smtpMessageIdDomain: parsed.SMTP_MESSAGE_ID_DOMAIN || undefined,
    gmailScopes
  };
};

export const isProduction = (config: RuntimeConfig): boolean => config.nodeEnv === 'production';

export const hashText = (value: string): string => {
  return crypto.createHash('sha256').update(value).digest('hex');
};
