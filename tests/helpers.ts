import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { RuntimeConfig } from '../src/config/env.js';
import { DatabaseService } from '../src/db/database.js';
import { EncryptionService } from '../src/utils/crypto.js';
import { Logger } from '../src/utils/logger.js';
import { AccessProfileService } from '../src/services/access-profile-service.js';
import { AccountService } from '../src/services/account-service.js';
import { MailService } from '../src/services/mail-service.js';
import type { ManagedProtonBridge } from '../src/services/proton-bridge-manager.js';

export interface TestContext {
  config: RuntimeConfig & { databasePath: string };
  db: DatabaseService;
  app: ReturnType<typeof createApp>;
  accountService: AccountService;
  accessProfileService: AccessProfileService;
  mailService: MailService;
  cleanup: () => void;
  cryptoService: EncryptionService;
  managedProtonBridge?: ManagedProtonBridge;
}

const mkDbDir = (): string => mkdtempSync(join(tmpdir(), 'slab-email-test-'));

export const createTestContext = (
  overrides: Partial<RuntimeConfig> = {},
  options: {
    managedProtonBridgeFactory?: (accountService: AccountService) => ManagedProtonBridge;
  } = {}
): TestContext => {
  const dbDir = mkDbDir();
  const dbPath = join(dbDir, 'state.db');
  const masterKey = randomBytes(32);
  const config: RuntimeConfig & { databasePath: string } = {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    adminKey: 'local-admin-key',
    masterKey,
    googleClientId: 'test-google-client-id',
    googleClientSecret: 'test-google-client-secret',
    googleRedirectUri: 'http://127.0.0.1:6981/api/oauth/google/callback',
    microsoftClientId: 'test-microsoft-client-id',
    microsoftClientSecret: 'test-microsoft-client-secret',
    microsoftRedirectUri: 'http://127.0.0.1:6981/api/oauth/microsoft/callback',
    microsoftTenant: 'common',
    logLevel: 'error',
    maxSendsPerAccountPerHour: 20,
    mcpAllowedOrigins: ['127.0.0.1:6981'],
    mcpAllowedHostnames: ['127.0.0.1'],
    publicAdminAllowedOrigins: ['127.0.0.1:6981'],
    allowInsecureLoopback: true,
    gmailScopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.send'
    ],
    skipMigrations: false,
    protonBridgeBinary: '/missing/proton-bridge',
    protonBridgeControllerScript: '/missing/bridge_controller.py',
    protonBridgeDataPath: join(dbDir, 'proton-bridge'),
    protonBridgePython: '/usr/bin/python3',
    protonBridgeVersion: null,
    ...overrides,
    databasePath: dbPath
  };

  const logger = new Logger('error');
  const db = new DatabaseService(dbPath);
  const cryptoService = new EncryptionService({ masterKey: config.masterKey });
  const accountService = new AccountService({ db, cryptoService, config });
  const accessProfileService = new AccessProfileService(db);
  const mailService = new MailService(accountService, db, config);
  const managedProtonBridge = options.managedProtonBridgeFactory?.(accountService);
  const app = createApp({
    config,
    db,
    accountService,
    accessProfileService,
    mailService,
    logger,
    managedProtonBridge
  });

  const cleanup = () => {
    try {
      db.close();
    } catch {
      // best effort
    }
    try {
      rmSync(dbDir, { force: true, recursive: true });
    } catch {
      // ignore
    }
  };

  return {
    config,
    db,
    cryptoService,
    app,
    accountService,
    accessProfileService,
    mailService,
    managedProtonBridge,
    cleanup
  };
};

export const createProfileAndToken = async (
  ctx: TestContext,
  accountId: string,
  permissions?: { readEnabled?: boolean; draftEnabled?: boolean; sendEnabled?: boolean }
) => {
  const payload = {
    name: `Profile-${accountId}`,
    readEnabled: permissions?.readEnabled ?? true,
    draftEnabled: permissions?.draftEnabled ?? false,
    sendEnabled: permissions?.sendEnabled ?? false,
    accountIds: [accountId]
  };

  const profile = await requestCreate<{ id: string }>(ctx, 'post', '/api/access-profiles', payload);
  const tokenResp = await requestCreate<{ token: string }>(ctx, 'post', `/api/access-profiles/${profile.id}/tokens`, {});
  return { profileId: profile.id, token: tokenResp.token };
};

const requestCreate = async <T>(ctx: TestContext, method: 'post' | 'patch', path: string, body: Record<string, unknown>): Promise<T> => {
  const response = await request(ctx.app)[method](path).set('Authorization', `Bearer ${ctx.config.adminKey}`).send(body);
  const status = method === 'post' ? 201 : 200;
  if (response.status !== status) {
    throw new Error(`expected ${status} from ${method.toUpperCase()} ${path}, got ${response.status}`);
  }
  return response.body as T;
};
