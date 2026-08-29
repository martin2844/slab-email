import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { AuthenticatedRequest } from '../middleware/auth.js';
import { MailService } from '../services/mail-service.js';
import { ApiError, ERROR_CODES } from '../types/errors.js';

export interface McpContext {
  profileId: string;
  accountIds: string[];
}

const ACCOUNT_LIST_TOOL: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

const MAIL_READ_TOOL: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
};

const DRAFT_TOOL: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true
};

const DELIVERY_TOOL: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
};

const sanitizeError = (error: unknown): string => {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'unexpected error';
};

const asStructuredContent = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const textContent = (value: string): { type: 'text'; text: string }[] => [{ type: 'text', text: value }];

const toolError = (error: unknown) => {
  const normalized = error instanceof ApiError ? `${error.code}: ${error.message}` : sanitizeError(error);
  const safeDetails =
    error instanceof ApiError &&
    (error.code === ERROR_CODES.SENDER_IDENTITY_MISMATCH ||
      error.code === ERROR_CODES.REPLY_PLAN_MISMATCH ||
      error.code === ERROR_CODES.SEND_OUTCOME_UNKNOWN)
      ? error.details
      : undefined;
  const detail = safeDetails ? JSON.stringify(safeDetails) : undefined;
  return {
    isError: true,
    content: textContent(detail ? `${normalized} ${detail}` : normalized),
    structuredContent: asStructuredContent({
      error: sanitizeError(error),
      code: error instanceof ApiError ? error.code : ERROR_CODES.INTERNAL_ERROR,
      ...(safeDetails ? { details: safeDetails } : {})
    })
  };
};

const parseAddressField = (value: unknown): { address: string }[] => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === 'string' ? entry : String(entry)))
      .filter(Boolean)
      .map((entry) => ({ address: String(entry).trim().toLowerCase() }));
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
      .map((address) => ({ address }));
  }
  return [];
};

const ensureArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean)
    .filter((entry) => entry.length > 0);
};

const assertWorkflowReplyTarget = (
  req: AuthenticatedRequest,
  input: { accountId: string; messageId: string }
) => {
  const accountHash = req.header('x-slab-reply-account-sha256');
  const messageHash = req.header('x-slab-reply-message-sha256');
  if (accountHash === undefined && messageHash === undefined) return;
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  if (
    !accountHash ||
    !messageHash ||
    digest(input.accountId) !== accountHash ||
    digest(input.messageId) !== messageHash
  ) {
    throw new ApiError(
      ERROR_CODES.WORKFLOW_TARGET_MISMATCH,
      'email_reply must target the inbound account and message fixed at workflow start',
      403
    );
  }
};

const searchInputSchema = z.object({
  accountId: z.string().trim().min(1),
  query: z.string().trim().optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  subject: z.string().trim().optional(),
  since: z.string().trim().optional(),
  before: z.string().trim().optional(),
  unread: z.coerce.boolean().optional(),
  limit: z.preprocess((value) => {
    if (value === undefined) return undefined;
    const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }, z.number().int().min(1).max(100).optional()),
  cursor: z.string().trim().optional()
});

const listAccountsInputSchema = z.object({}).strict();

const getMessageInputSchema = z.object({
  accountId: z.string().trim().min(1),
  messageId: z.string().trim().min(1)
});

const listThreadInputSchema = z.object({
  accountId: z.string().trim().min(1),
  threadId: z.string().trim().min(1)
});

const draftInputSchema = z.object({
  accountId: z.string().trim().min(1),
  to: z.array(z.string().trim().email()).min(1),
  cc: z.array(z.string().trim().email()).optional(),
  bcc: z.array(z.string().trim().email()).optional(),
  subject: z.string().trim().min(1),
  text: z.string().trim().min(1),
  html: z.string().optional()
});

const agenticMessageSchema = z.object({
  accountId: z.string().trim().min(1),
  to: z.array(z.string().trim().email()).min(1),
  cc: z.array(z.string().trim().email()).optional(),
  bcc: z.array(z.string().trim().email()).optional(),
  subject: z.string().trim().min(1).max(998),
  text: z.string().trim().min(1).max(100_000)
});

const sendInputSchema = agenticMessageSchema.extend({
  expectedFrom: z.string().trim().toLowerCase().email().describe(
    'Exact sender address returned by the latest email_list_accounts call. The send is rejected if the account identity changed.'
  ),
  idempotencyKey: z.string().trim().min(1)
});

const replyInputSchema = z.object({
  accountId: z.string().trim().min(1),
  expectedFrom: z.string().trim().toLowerCase().email().describe(
    'Exact sender address returned by the latest email_list_accounts call. The reply is rejected if the account identity changed.'
  ),
  messageId: z.string().trim().min(1),
  to: z.array(z.string().trim().email()).length(1).describe(
    'Exact original sender returned by email_get_message. Replies are rejected if the source message no longer matches.'
  ),
  expectedSubject: z.string().trim().min(1).max(998).describe(
    'Exact reply subject shown for approval, including the Re: prefix when needed.'
  ),
  text: z.string().trim().min(1).max(100_000),
  idempotencyKey: z.string().trim().min(1)
});

export const createMcpTools = (
  server: McpServer,
  mailService: MailService,
  req: AuthenticatedRequest,
  _context: McpContext
): void => {
  const profile = req.authContext?.type === 'profile' ? req.authContext.profile : undefined;
  if (!profile) return;

  if (profile.readEnabled || profile.draftEnabled || profile.sendEnabled)
    server.registerTool(
      'email_list_accounts',
      {
        description: 'List accounts visible for this access profile',
        inputSchema: listAccountsInputSchema,
        annotations: ACCOUNT_LIST_TOOL
      },
      async (rawArgs, _extra) => {
        listAccountsInputSchema.parse(rawArgs);
        const accounts = mailService.listAccounts(req).map((account) => ({
          id: account.id,
          email: account.emailAddress,
          displayName: account.displayName,
          sendAs: {
            email: account.emailAddress,
            displayName: account.displayName
          },
          provider: account.provider,
          capabilities: {
            read: account.capabilities.read,
            draft: account.capabilities.draft,
            send: account.capabilities.send,
            reply: account.capabilities.reply,
            search: account.capabilities.search,
            threads: account.capabilities.threads
          }
        }));

        return {
          structuredContent: asStructuredContent({ items: accounts }),
          content: textContent(`accounts: ${accounts.length}`)
        };
      }
    );

  if (profile.readEnabled)
    server.registerTool(
      'email_search',
      {
        description: 'Search messages on a connected account',
        inputSchema: searchInputSchema,
        annotations: MAIL_READ_TOOL
      },
      async (rawArgs, _extra) => {
        const args = searchInputSchema.parse(rawArgs);
        try {
          const result = await mailService.search(req, {
            accountId: args.accountId,
            query: args.query,
            from: args.from,
            to: args.to,
            subject: args.subject,
            since: args.since,
            before: args.before,
            unread: args.unread,
            limit: args.limit,
            cursor: args.cursor
          });
          return {
            structuredContent: asStructuredContent(result),
            content: textContent(`search results: ${result.items.length}`)
          };
        } catch (error) {
          return toolError(error);
        }
      }
    );

  if (profile.readEnabled)
    server.registerTool(
      'email_get_message',
      {
        description: 'Get message by account and message id',
        inputSchema: getMessageInputSchema,
        annotations: MAIL_READ_TOOL
      },
      async (rawArgs, _extra) => {
        const args = getMessageInputSchema.parse(rawArgs);
        try {
          const message = await mailService.getMessage(req, args.accountId, args.messageId);
          return {
            structuredContent: asStructuredContent(message),
            content: textContent(`${message.subject || '(no subject)'} ${message.id}`)
          };
        } catch (error) {
          return toolError(error);
        }
      }
    );

  if (profile.readEnabled)
    server.registerTool(
      'email_list_threads',
      {
        description: 'Read all messages for a thread',
        inputSchema: listThreadInputSchema,
        annotations: MAIL_READ_TOOL
      },
      async (rawArgs, _extra) => {
        const args = listThreadInputSchema.parse(rawArgs);
        try {
          const thread = await mailService.getThread(req, args.accountId, args.threadId);
          return {
            structuredContent: asStructuredContent({ items: thread }),
            content: textContent(`thread size: ${thread.length}`)
          };
        } catch (error) {
          return toolError(error);
        }
      }
    );

  if (profile.draftEnabled)
    server.registerTool(
      'email_create_draft',
      {
        description: 'Create a remote draft message',
        inputSchema: draftInputSchema,
        annotations: DRAFT_TOOL
      },
      async (rawArgs, _extra) => {
        const args = draftInputSchema.parse(rawArgs);
        try {
          const result = await mailService.createDraft(req, {
            accountId: args.accountId,
            to: parseAddressField(args.to),
            cc: ensureArray(args.cc)?.map((entry) => ({ address: entry })),
            bcc: ensureArray(args.bcc)?.map((entry) => ({ address: entry })),
            subject: args.subject,
            text: args.text,
            html: args.html
          });
          return {
            structuredContent: asStructuredContent(result),
            content: textContent(`draft: ${result.draftId}`)
          };
        } catch (error) {
          return toolError(error);
        }
      }
    );

  if (profile.sendEnabled)
    server.registerTool(
      'email_send',
      {
        description: 'Send email from the verified account identity. Pass expectedFrom from the latest email_list_accounts result and an idempotencyKey.',
        inputSchema: sendInputSchema,
        annotations: DELIVERY_TOOL
      },
      async (rawArgs, _extra) => {
        const args = sendInputSchema.parse(rawArgs);
        if (!args.idempotencyKey) {
          return toolError(new ApiError(ERROR_CODES.INVALID_INPUT, 'idempotencyKey is required for email_send', 400));
        }
        try {
          const result = await mailService.send(req, {
            accountId: args.accountId,
            expectedFrom: args.expectedFrom,
            to: parseAddressField(args.to),
            cc: ensureArray(args.cc)?.map((entry) => ({ address: entry })),
            bcc: ensureArray(args.bcc)?.map((entry) => ({ address: entry })),
            subject: args.subject,
            text: args.text,
            idempotencyKey: args.idempotencyKey
          });
          return {
            structuredContent: asStructuredContent(result),
            content: textContent(`send: ${result.status}`)
          };
        } catch (error) {
          return toolError(error);
        }
      }
    );

  if (profile.readEnabled && profile.sendEnabled)
    server.registerTool(
      'email_reply',
      {
        description: 'Reply to one verified original sender. Pass expectedFrom from email_list_accounts, and to plus expectedSubject from the latest email_get_message read.',
        inputSchema: replyInputSchema,
        annotations: DELIVERY_TOOL
      },
      async (rawArgs, _extra) => {
        const args = replyInputSchema.parse(rawArgs);
        try {
          assertWorkflowReplyTarget(req, args);
        } catch (error) {
          return toolError(error);
        }
        if (!args.idempotencyKey) {
          return toolError(new ApiError(ERROR_CODES.INVALID_INPUT, 'idempotencyKey is required for email_reply', 400));
        }
        try {
          const result = await mailService.reply(req, {
            accountId: args.accountId,
            expectedFrom: args.expectedFrom,
            expectedSubject: args.expectedSubject,
            messageId: args.messageId,
            to: ensureArray(args.to)?.map((entry) => ({ address: entry })),
            text: args.text,
            idempotencyKey: args.idempotencyKey
          });
          return {
            structuredContent: asStructuredContent(result),
            content: textContent(`reply: ${result.status}`)
          };
        } catch (error) {
          return toolError(error);
        }
      }
    );
};

export const createMcpServer = (name: string, version: string): McpServer => {
  return new McpServer({
    name,
    version
  });
};
