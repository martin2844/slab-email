import { createServer } from 'node:http';

import { createApp } from './app.js';
import { RuntimeConfig, loadConfig } from './config/env.js';
import { DatabaseService } from './db/database.js';
import { EncryptionService } from './utils/crypto.js';
import { Logger } from './utils/logger.js';
import { AccessProfileService } from './services/access-profile-service.js';
import { AccountService } from './services/account-service.js';
import { MailService } from './services/mail-service.js';

const setup = (config: RuntimeConfig) => {
  const logger = new Logger(config.logLevel);
  const db = new DatabaseService(config.databasePath);
  const crypto = new EncryptionService({ masterKey: config.masterKey });
  const accountService = new AccountService({ db, cryptoService: crypto, config });
  const accessProfileService = new AccessProfileService(db);
  const mailService = new MailService(accountService, db, config);

  const app = createApp({
    config,
    db,
    accountService,
    accessProfileService,
    mailService,
    logger
  });

  return { app, logger, config };
};

const main = async () => {
  const config = loadConfig();
  const { app, logger, config: loadedConfig } = setup(config);

  const server = createServer(app);

  server.listen(loadedConfig.port, loadedConfig.host, () => {
    logger.info('slab-email started', {
      host: loadedConfig.host,
      port: loadedConfig.port,
      status: 'ok'
    });
  });

  const shutdown = () => {
    server.close(() => {
      logger.info('slab-email stopped');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
