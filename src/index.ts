import { createServer } from 'node:http';
import { accessSync, constants } from 'node:fs';

import { createApp } from './app.js';
import { RuntimeConfig, loadConfig } from './config/env.js';
import { DatabaseService } from './db/database.js';
import { EncryptionService } from './utils/crypto.js';
import { Logger } from './utils/logger.js';
import { AccessProfileService } from './services/access-profile-service.js';
import { AccountService } from './services/account-service.js';
import { MailService } from './services/mail-service.js';
import { ManagedProtonBridge } from './services/proton-bridge-manager.js';
import { PythonProtonBridgeController } from './proton/controller.js';

const setup = (config: RuntimeConfig) => {
  const logger = new Logger(config.logLevel);
  const db = new DatabaseService(config.databasePath, { migrate: !config.skipMigrations });
  const crypto = new EncryptionService({ masterKey: config.masterKey });
  const accountService = new AccountService({ db, cryptoService: crypto, config });
  const accessProfileService = new AccessProfileService(db);
  const mailService = new MailService(accountService, db, config);
  const managedProtonBridge = new ManagedProtonBridge({
    controller: new PythonProtonBridgeController({
      pythonBinary: config.protonBridgePython,
      controllerScript: config.protonBridgeControllerScript,
      bridgeBinary: config.protonBridgeBinary,
      dataDirectory: config.protonBridgeDataPath
    }),
    accountService,
    available:
      isExecutable(config.protonBridgeBinary) &&
      isReadable(config.protonBridgeControllerScript) &&
      isExecutable(config.protonBridgePython),
    version: config.protonBridgeVersion
  });

  const app = createApp({
    config,
    db,
    accountService,
    accessProfileService,
    mailService,
    logger,
    managedProtonBridge
  });

  return { app, logger, config, db, managedProtonBridge };
};

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const isReadable = (path: string): boolean => {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

const main = async () => {
  const config = loadConfig();
  const { app, logger, config: loadedConfig, db, managedProtonBridge } = setup(config);

  void managedProtonBridge.startIfConfigured().catch(() => {
    logger.warn('managed Proton Bridge could not start');
  });

  const server = createServer(app);

  server.listen(loadedConfig.port, loadedConfig.host, () => {
    logger.info('slab-email started', {
      host: loadedConfig.host,
      port: loadedConfig.port,
      status: 'ok'
    });
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(async () => {
      await managedProtonBridge.shutdown().catch(() => undefined);
      db.close();
      logger.info('slab-email stopped');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
