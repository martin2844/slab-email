import { NextFunction, Request, Response } from 'express';
import { ERROR_CODES, ApiError } from '../types/errors.js';
import { ScopedAuthContext } from '../types/models.js';
import { RuntimeConfig, hashText } from '../config/env.js';
import { DatabaseService } from '../db/database.js';

export interface AuthenticatedRequest extends Request {
  authContext?: ScopedAuthContext;
}

const extractBearerToken = (req: Request): string | undefined => {
  const header = req.header('authorization');
  if (!header) return undefined;
  if (header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  return undefined;
};

export const getBearerToken = (req: Request): string | undefined => extractBearerToken(req);

export const requireAdmin = (config: RuntimeConfig) => (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const token = extractBearerToken(_req) || _req.header('x-slab-admin-key');
  if (!token || token !== config.adminKey) {
    next(new ApiError(ERROR_CODES.AUTH_REQUIRED, 'admin authentication required', 401));
    return;
  }
  _req.authContext = { type: 'admin' };
  next();
};

export const requireProfileToken = (db: DatabaseService) => async (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
) => {
  const token = extractBearerToken(req);
  if (!token) {
    next(new ApiError(ERROR_CODES.AUTH_REQUIRED, 'access token required', 401));
    return;
  }
  const context = db.getScopeContextForToken(hashText(token));
  if (!context) {
    next(new ApiError(ERROR_CODES.AUTH_REQUIRED, 'access token not found', 401));
    return;
  }
  req.authContext = context;
  next();
};

export const requireReadPermission = (req: AuthenticatedRequest, operation: 'read' | 'draft' | 'send') => {
  const context = req.authContext;
  if (!context || context.type !== 'profile' || !context.profile) return false;
  if (operation === 'read') return context.profile.readEnabled;
  if (operation === 'draft') return context.profile.draftEnabled;
  return context.profile.sendEnabled;
};
