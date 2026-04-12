import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { appLogService } from '../services/appLogService';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const statusCode = 500;
  const requestId = typeof (req as any).requestId === 'string' ? String((req as any).requestId) : null;
  const userId = Number.isInteger((req as any).userId) ? Number((req as any).userId) : null;
  const stackSnippet = typeof err.stack === 'string' ? err.stack.substring(0, 2000) : undefined;

  logger.error('Unhandled error:', {
    message: err.message,
    stack: err.stack,
    url: req.url,
    requestId,
    userId,
  });

  appLogService.enqueue({
    action: 'UNHANDLED_EXCEPTION',
    module: 'error-handler',
    severity: 'ERROR',
    status: 'SERVER_ERROR',
    userId,
    message: err.message || 'Unhandled server error',
    requestId,
    httpMethod: req.method || 'UNKNOWN',
    httpPath: req.originalUrl || req.url || '',
    httpStatus: statusCode,
    metadata: {
      stack: stackSnippet,
    },
  });

  res.status(500).json({
    error: 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { details: err.message }),
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: `Route ${req.method} ${req.url} not found` });
}
