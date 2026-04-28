import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { logger } from '../utils/logger';
import { query } from '../database/connection';
import { ensureUserLockoutSchema } from '../database/schemaMaintenance';

export interface AuthRequest extends Request {
  userId?: number;
  userRole?: string;
  requestId?: string;
  username?: string;
}

export async function authenticate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Access denied. No token provided.' });
    return;
  }

  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, config.jwt.secret) as { userId: number; role: string };
    await ensureUserLockoutSchema();
    const users = await query<{ username: string; role: string; is_active: boolean; is_locked: boolean }>(
      'SELECT username, role, is_active, is_locked FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (users.length === 0) {
      res.status(401).json({ error: 'User account no longer exists.' });
      return;
    }

    const user = users[0];
    if (!user.is_active) {
      res.status(403).json({ error: 'This account has been disabled.' });
      return;
    }

    if (user.is_locked) {
      res.status(423).json({ error: 'This account is locked. Please contact an administrator to unlock it.' });
      return;
    }

    req.userId = decoded.userId;
    req.userRole = user.role || decoded.role;
    req.username = user.username;
    next();
  } catch (error: any) {
    if (error.name === 'TokenExpiredError') {
      logger.warn('Session expired', { ip: req.ip });
      res.status(401).json({ error: 'Session expired.', code: 'SESSION_EXPIRED' });
    } else {
      logger.warn('Invalid token attempt', { ip: req.ip });
      res.status(401).json({ error: 'Invalid or expired token.' });
    }
  }
}

export function authorize(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.userRole || !roles.includes(req.userRole)) {
      res.status(403).json({ error: 'Insufficient permissions.' });
      return;
    }
    next();
  };
}
