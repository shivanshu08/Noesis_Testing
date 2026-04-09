import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  logger.error('Unhandled error:', { message: err.message, stack: err.stack, url: req.url });
  res.status(500).json({
    error: 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { details: err.message }),
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: `Route ${req.method} ${req.url} not found` });
}
