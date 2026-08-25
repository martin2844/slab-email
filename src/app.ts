import type { ErrorRequestHandler } from 'express';
import express, { NextFunction, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';

import { RuntimeConfig } from './config/env.js';
import { DatabaseService } from './db/database.js';
import { Logger } from './utils/logger.js';
import { AccessProfileService } from './services/access-profile-service.js';
import { AccountService } from './services/account-service.js';
import { MailService } from './services/mail-service.js';
import {
  accessProfileSchema,
  createImapSmtpAccountSchema,
  createAgentMailAccountSchema,
  createResendAccountSchema,
  createProtonBridgeAccountSchema,
  draftSchema,
  gmailConnectSchema,
  googleOauthSettingsSchema,
  microsoftOauthSettingsSchema,
  managedProtonAbortSchema,
  managedProtonChallengeSchema,
  managedProtonConnectSchema,
  idempotentSendSchema,
  oauthCallbackSchema,
  parseLimit,
  patchAccountSchema,
  replySchema,
  searchParamsSchema
} from './api/schemas.js';
import { requireAdmin, requireProfileToken, getBearerToken, AuthenticatedRequest } from './middleware/auth.js';
import { ApiError, ApiErrorPayload, ERROR_CODES } from './types/errors.js';
import { hashText } from './config/env.js';
import { buildOriginMatcher, isOriginAllowed } from './utils/origin.js';
import { createMcpServer, createMcpTools } from './mcp/server.js';
import type { ManagedProtonBridge } from './services/proton-bridge-manager.js';

export interface AppContext {
  config: RuntimeConfig;
  db: DatabaseService;
  accountService: AccountService;
  accessProfileService: AccessProfileService;
  mailService: MailService;
  logger: Logger;
  managedProtonBridge?: ManagedProtonBridge;
}

const toJsonError = (error: ApiError): Record<string, unknown> => ({
  error: ApiErrorPayload(error)
});

const toHttpError = (error: unknown): { status: number; body: Record<string, unknown> } => {
  if (error instanceof ApiError) {
    return { status: error.status, body: toJsonError(error) };
  }

  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: ERROR_CODES.INVALID_INPUT,
          message: 'Invalid request payload',
          details: { issues: error.issues }
        }
      }
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: error instanceof Error ? error.message : 'Unexpected error'
      }
    }
  };
};

const safeString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

const safeParam = (params: Record<string, string | string[]>, key: string): string => {
  const raw = params[key];
  return typeof raw === 'string' ? raw : Array.isArray(raw) ? (raw.find((entry) => typeof entry === 'string') ?? '') : '';
};

const firstQueryValue = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.find((entry): entry is string => typeof entry === 'string');
  }
  return undefined;
};

const normalizeQuery = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== 'object') {
    return {};
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const normalized = firstQueryValue(value);
    if (normalized !== undefined) {
      out[key] = normalized;
    }
  }

  return out;
};

export const createApp = (ctx: AppContext): express.Express => {
  const app = express();
  const mcpOriginSet = buildOriginMatcher(ctx.config.mcpAllowedOrigins);

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });
  app.get('/ready', (_req, res) => {
    try {
      ctx.db.ping();
      const migrations = ctx.db.getMigrationStatus();
      res.status(migrations.ready ? 200 : 503).json({
        status: migrations.ready ? 'ready' : 'not_ready',
        database: 'ok',
        migrations
      });
    } catch {
      res.status(503).json({ status: 'not_ready', database: 'error' });
    }
  });

  const adminAuth = requireAdmin(ctx.config);
  const apiAuth = requireProfileToken(ctx.db);

  app.get('/api/accounts', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (getBearerToken(req) === ctx.config.adminKey || req.header('x-slab-admin-key') === ctx.config.adminKey) {
      req.authContext = { type: 'admin' };
      res.status(200).json(ctx.accountService.listAccounts());
      return;
    }
    await apiAuth(req, res, (error?: unknown) => {
      if (error) {
        next(error);
        return;
      }
      try {
        res.status(200).json(ctx.mailService.listAccounts(req));
      } catch (listError) {
        next(listError);
      }
    });
  });

  app.get('/api/health', adminAuth, (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  const oauthRouter = express.Router();
  oauthRouter.get('/oauth/google/callback', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = oauthCallbackSchema.parse(normalizeQuery(req.query));
      const result = await ctx.accountService.completeGmailConnection(payload);
      res.status(200).json({ ...result, created: true });
    } catch (error) {
      next(error);
    }
  });
  oauthRouter.get('/oauth/microsoft/callback', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = oauthCallbackSchema.parse(normalizeQuery(req.query));
      const result = await ctx.accountService.completeMicrosoftConnection(payload);
      res.status(200).json({ ...result, created: true });
    } catch (error) {
      next(error);
    }
  });
  app.use('/api', oauthRouter);

  const adminRouter = express.Router();

  adminRouter.get('/proton-bridge', adminAuth, async (_req, res) => {
    if (!ctx.managedProtonBridge) {
      res.status(200).json({
        available: false,
        version: null,
        state: 'unavailable',
        message: 'Managed Proton Bridge is not installed.',
        accounts: []
      });
      return;
    }
    res.status(200).json(await ctx.managedProtonBridge.status());
  });

  adminRouter.post('/proton-bridge/connect', adminAuth, async (req, res, next) => {
    try {
      if (!ctx.managedProtonBridge) {
        throw new ApiError(
          ERROR_CODES.INVALID_CONFIGURATION,
          'Managed Proton Bridge is not installed.',
          409
        );
      }
      const input = managedProtonConnectSchema.parse(req.body ?? {});
      res.status(200).json(await ctx.managedProtonBridge.connect(input));
    } catch (error) {
      next(error);
    }
  });

  adminRouter.post('/proton-bridge/challenge', adminAuth, async (req, res, next) => {
    try {
      if (!ctx.managedProtonBridge) {
        throw new ApiError(
          ERROR_CODES.INVALID_CONFIGURATION,
          'Managed Proton Bridge is not installed.',
          409
        );
      }
      const input = managedProtonChallengeSchema.parse(req.body ?? {});
      res.status(200).json(await ctx.managedProtonBridge.continueLogin(input));
    } catch (error) {
      next(error);
    }
  });

  adminRouter.post('/proton-bridge/abort', adminAuth, async (req, res, next) => {
    try {
      if (!ctx.managedProtonBridge) {
        res.status(204).send();
        return;
      }
      const { challengeId } = managedProtonAbortSchema.parse(req.body ?? {});
      await ctx.managedProtonBridge.abort(challengeId);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  adminRouter.delete('/proton-bridge/accounts/:id', adminAuth, async (req, res, next) => {
    try {
      if (!ctx.managedProtonBridge) {
        throw new ApiError(
          ERROR_CODES.INVALID_CONFIGURATION,
          'Managed Proton Bridge is not installed.',
          409
        );
      }
      const accountId = safeParam(req.params as Record<string, string | string[]>, 'id');
      await ctx.managedProtonBridge.disconnectAccount(accountId);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  adminRouter.post('/proton-bridge/accounts/:id/sync-addresses', adminAuth, async (req, res, next) => {
    try {
      if (!ctx.managedProtonBridge) {
        throw new ApiError(
          ERROR_CODES.INVALID_CONFIGURATION,
          'Managed Proton Bridge is not installed.',
          409
        );
      }
      const accountId = safeParam(req.params as Record<string, string | string[]>, 'id');
      res.status(200).json(await ctx.managedProtonBridge.syncAddresses(accountId));
    } catch (error) {
      next(error);
    }
  });

  adminRouter.get('/settings/google-oauth', adminAuth, (_req, res) => {
    res.status(200).json(ctx.accountService.getGoogleOAuthSettings());
  });

  adminRouter.patch('/settings/google-oauth', adminAuth, (req, res, next) => {
    try {
      const payload = googleOauthSettingsSchema.parse(req.body ?? {});
      res.status(200).json(ctx.accountService.saveGoogleOAuthSettings(payload));
    } catch (error) {
      next(error);
    }
  });

  adminRouter.get('/settings/microsoft-oauth', adminAuth, (_req, res) => {
    res.status(200).json(ctx.accountService.getMicrosoftOAuthSettings());
  });

  adminRouter.patch('/settings/microsoft-oauth', adminAuth, (req, res, next) => {
    try {
      const payload = microsoftOauthSettingsSchema.parse(req.body ?? {});
      res.status(200).json(ctx.accountService.saveMicrosoftOAuthSettings(payload));
    } catch (error) {
      next(error);
    }
  });

  adminRouter.get('/accounts/:id', adminAuth, (req: AuthenticatedRequest, res: Response) => {
    const accountId = safeParam(req.params as Record<string, string | string[]>, 'id');
    const account = ctx.accountService.getAccount(accountId);
    res.status(200).json(account);
  });

  adminRouter.post('/accounts/proton-bridge', adminAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const payload = createProtonBridgeAccountSchema.parse(req.body);
      const account = ctx.accountService.createProtonBridgeAccount(payload);
      res.status(201).json(account);
    } catch (error) {
      next(error);
    }
  });

  adminRouter.post('/accounts/imap-smtp', adminAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const payload = createImapSmtpAccountSchema.parse(req.body);
      const account = ctx.accountService.createImapSmtpAccount(payload);
      res.status(201).json(account);
    } catch (error) {
      next(error);
    }
  });

  adminRouter.post('/accounts/agentmail', adminAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const account = ctx.accountService.createAgentMailAccount(createAgentMailAccountSchema.parse(req.body));
      res.status(201).json(account);
    } catch (error) {
      next(error);
    }
  });

  adminRouter.post('/accounts/resend', adminAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const account = ctx.accountService.createResendAccount(createResendAccountSchema.parse(req.body));
      res.status(201).json(account);
    } catch (error) {
      next(error);
    }
  });

  const updateAccount = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = patchAccountSchema.parse(req.body);
      const id = safeParam(req.params as Record<string, string | string[]>, 'id');
      const { username, password, apiKey, ...config } = parsed;

      const account = ctx.accountService.updateAccount(
        id,
        config,
        username || password || apiKey
          ? {
              username: username,
              password: password,
              apiKey,
            }
          : undefined
      );
      res.status(200).json(account);
    } catch (error) {
      next(error);
    }
  };

  adminRouter.patch('/accounts/:id', adminAuth, updateAccount);
  // Backwards-compatible alias for clients created before PATCH was exposed.
  adminRouter.post('/accounts/:id', adminAuth, updateAccount);

  adminRouter.delete('/accounts/:id', adminAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const accountId = safeParam(req.params as Record<string, string | string[]>, 'id');
      const account = ctx.accountService.getAccount(accountId);
      if (
        account.provider === 'proton_bridge' &&
        'managedBridge' in account.config &&
        account.config.managedBridge === true
      ) {
        if (!ctx.managedProtonBridge) {
          throw new ApiError(
            ERROR_CODES.INVALID_CONFIGURATION,
            'Managed Proton Bridge is not installed.',
            409
          );
        }
        await ctx.managedProtonBridge.disconnectAccount(accountId);
      } else {
        ctx.accountService.deleteAccount(accountId);
      }
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  adminRouter.post('/accounts/:id/enable', adminAuth, (req: AuthenticatedRequest, res: Response) => {
    const accountId = safeParam(req.params as Record<string, string | string[]>, 'id');
    const account = ctx.accountService.setEnabled(accountId, true);
    res.status(200).json(account);
  });

  adminRouter.post('/accounts/:id/disable', adminAuth, (req: AuthenticatedRequest, res: Response) => {
    const accountId = safeParam(req.params as Record<string, string | string[]>, 'id');
    const account = ctx.accountService.setEnabled(accountId, false);
    res.status(200).json(account);
  });

  adminRouter.post('/accounts/:id/test', adminAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const accountId = safeParam(req.params as Record<string, string | string[]>, 'id');
      const result = await ctx.accountService.testAccount(accountId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  adminRouter.post('/accounts/gmail/connect', adminAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const payload = gmailConnectSchema.parse(req.body ?? {});
      const { authorizationUrl, state, expiresAt } = ctx.accountService.createGmailAuthorizationUrl(payload);
      res.status(200).json({
        authorizationUrl,
        state,
        expiresAt,
        stateExpiresAt: expiresAt
      });
    } catch (error) {
      next(error);
    }
  });

  adminRouter.post('/accounts/microsoft/connect', adminAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const payload = gmailConnectSchema.parse(req.body ?? {});
      const { authorizationUrl, state, expiresAt } = ctx.accountService.createMicrosoftAuthorizationUrl(payload);
      res.status(200).json({ authorizationUrl, state, expiresAt, stateExpiresAt: expiresAt });
    } catch (error) {
      next(error);
    }
  });

  adminRouter.get('/access-profiles', adminAuth, (_req: AuthenticatedRequest, res: Response) => {
    const profiles = ctx.accessProfileService.list();
    res.status(200).json(profiles);
  });

  adminRouter.post('/access-profiles', adminAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const payload = accessProfileSchema.parse(req.body);
      const profile = ctx.accessProfileService.create(payload);
      res.status(201).json(profile);
    } catch (error) {
      next(error);
    }
  });

  adminRouter.get('/access-profiles/:id', adminAuth, (req: AuthenticatedRequest, res: Response) => {
    const profileId = safeParam(req.params as Record<string, string | string[]>, 'id');
    const profile = ctx.accessProfileService.get(profileId);
    res.status(200).json(profile);
  });

  adminRouter.patch('/access-profiles/:id', adminAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const payload = accessProfileSchema.parse(req.body);
      const profileId = safeParam(req.params as Record<string, string | string[]>, 'id');
      const profile = ctx.accessProfileService.update(profileId, payload);
      res.status(200).json(profile);
    } catch (error) {
      next(error);
    }
  });

  adminRouter.delete('/access-profiles/:id', adminAuth, (req: AuthenticatedRequest, res: Response) => {
    const profileId = safeParam(req.params as Record<string, string | string[]>, 'id');
    ctx.accessProfileService.remove(profileId);
    res.status(204).send();
  });

  adminRouter.post('/access-profiles/:id/tokens', adminAuth, (req: AuthenticatedRequest, res: Response) => {
    const profileId = safeParam(req.params as Record<string, string | string[]>, 'id');
    const tokenBundle = ctx.accessProfileService.createToken(profileId);
    res.status(201).json(tokenBundle);
  });

  adminRouter.get('/access-profiles/:id/tokens', adminAuth, (req: AuthenticatedRequest, res: Response) => {
    const profileId = safeParam(req.params as Record<string, string | string[]>, 'id');
    const tokens = ctx.accessProfileService.listTokens(profileId);
    res.status(200).json(tokens);
  });

  adminRouter.delete('/access-profiles/:id/tokens/:tokenId', adminAuth, (req: AuthenticatedRequest, res: Response) => {
    const profileId = safeParam(req.params as Record<string, string | string[]>, 'id');
    const tokenId = safeParam(req.params as Record<string, string | string[]>, 'tokenId');
    ctx.accessProfileService.revokeToken(profileId, tokenId);
    res.status(204).send();
  });

  app.use('/api', adminRouter);

  const mailRouter = express.Router();
  mailRouter.use(apiAuth);

  mailRouter.get('/mail/search', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = searchParamsSchema.parse(normalizeQuery(req.query));
      const result = await ctx.mailService.search(req, {
        accountId: safeString(parsed.accountId),
        query: parsed.query,
        from: parsed.from,
        to: parsed.to,
        subject: parsed.subject,
        since: parsed.since,
        before: parsed.before,
        unread: parsed.unread,
        limit: parseLimit(parsed.limit, 20),
        cursor: parsed.cursor
      });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  mailRouter.get('/mail/messages/:accountId/:messageId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const accountId = safeParam(req.params as Record<string, string | string[]>, 'accountId');
      const messageId = safeParam(req.params as Record<string, string | string[]>, 'messageId');
      const message = await ctx.mailService.getMessage(req, accountId, messageId);
      res.status(200).json(message);
    } catch (error) {
      next(error);
    }
  });

  mailRouter.get('/mail/threads/:accountId/:threadId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const accountId = safeParam(req.params as Record<string, string | string[]>, 'accountId');
      const threadId = safeParam(req.params as Record<string, string | string[]>, 'threadId');
      const thread = await ctx.mailService.getThread(req, accountId, threadId);
      res.status(200).json(thread);
    } catch (error) {
      next(error);
    }
  });

  mailRouter.post('/mail/drafts', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const payload = draftSchema.parse(req.body);
      const result = await ctx.mailService.createDraft(req, {
        accountId: payload.accountId,
        to: payload.to.map((address) => ({ address, name: undefined })),
        cc: payload.cc?.map((address) => ({ address, name: undefined })),
        bcc: payload.bcc?.map((address) => ({ address, name: undefined })),
        subject: payload.subject,
        text: payload.text,
        html: payload.html
      });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  mailRouter.post('/mail/send', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const payload = idempotentSendSchema.parse(req.body);
      const result = await ctx.mailService.send(req, {
        accountId: payload.accountId,
        to: payload.to.map((address) => ({ address, name: undefined })),
        cc: payload.cc?.map((address) => ({ address, name: undefined })),
        bcc: payload.bcc?.map((address) => ({ address, name: undefined })),
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
        expectedFrom: payload.expectedFrom,
        idempotencyKey: payload.idempotencyKey
      });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  mailRouter.post('/mail/reply', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const payload = replySchema.parse(req.body);
      const result = await ctx.mailService.reply(req, {
        accountId: payload.accountId,
        expectedFrom: payload.expectedFrom,
        expectedSubject: payload.expectedSubject,
        messageId: payload.messageId,
        to: payload.to?.map((address) => ({ address, name: undefined })),
        cc: payload.cc?.map((address) => ({ address, name: undefined })),
        text: payload.text,
        html: payload.html,
        replyAll: payload.replyAll,
        idempotencyKey: payload.idempotencyKey
      });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', mailRouter);

  app.post('/mcp', apiAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!isOriginAllowed(req.header('origin') ?? undefined, mcpOriginSet)) {
      next(new ApiError(ERROR_CODES.AUTH_REQUIRED, 'origin denied', 403));
      return;
    }

    const token = req.header('authorization')?.slice(7);
    if (!token) {
      next(new ApiError(ERROR_CODES.AUTH_REQUIRED, 'profile token missing', 401));
      return;
    }

    const context = ctx.db.getScopeContextForToken(hashText(token));
    if (!context || context.type !== 'profile') {
      next(new ApiError(ERROR_CODES.AUTH_REQUIRED, 'invalid profile token', 401));
      return;
    }

    const requestId = req.header('x-request-id') ?? randomUUID();
    const requestedTool = req.body?.method === 'tools/call' && typeof req.body?.params?.name === 'string' ? req.body.params.name : null;
    const profile = context.profile;
    const deniedCapability =
      (requestedTool === 'email_create_draft' && !profile?.draftEnabled) ||
      (['email_send', 'email_reply'].includes(requestedTool ?? '') && !profile?.sendEnabled) ||
      (['email_search', 'email_get_message', 'email_list_threads'].includes(requestedTool ?? '') && !profile?.readEnabled) ||
      (requestedTool === 'email_list_accounts' &&
        !profile?.readEnabled &&
        !profile?.draftEnabled &&
        !profile?.sendEnabled);
    if (deniedCapability) {
      const payload = {
        jsonrpc: '2.0',
        id: req.body?.id ?? null,
        result: {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'PERMISSION_DENIED: tool is not enabled for this access profile'
            }
          ],
          structuredContent: {
            code: ERROR_CODES.PERMISSION_DENIED,
            error: 'tool is not enabled for this access profile'
          }
        }
      };
      res
        .status(200)
        .type('text/event-stream')
        .send(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      return;
    }
    const server = createMcpServer('slab-email', '0.1.0');
    createMcpTools(server, ctx.mailService, req, {
      profileId: context.profileId ?? 'unknown',
      accountIds: context.profile?.accountIds ?? []
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    server.connect(transport).catch((error) => {
      ctx.logger.error('mcp connect failed', {
        requestId,
        error
      });
    });

    try {
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      next(error);
    } finally {
      await server.close();
    }
  });

  const errHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    const mapped = toHttpError(error);
    res.status(mapped.status).json(mapped.body);
  };
  app.use(errHandler);

  return app;
};
