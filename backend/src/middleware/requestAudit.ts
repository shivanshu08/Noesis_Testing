import { randomUUID } from 'crypto';
import { NextFunction, Response } from 'express';
import { AuthRequest } from './auth';
import { appLogService, AppLogSeverity } from '../services/appLogService';

const SENSITIVE_KEYS = new Set([
  'password',
  'pass',
  'token',
  'authorization',
  'secret',
  'apikey',
  'api_key',
  'access_token',
  'refresh_token',
  'cookie',
]);

function extractModuleFromPath(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  const apiIdx = segments.indexOf('api');
  if (apiIdx >= 0 && segments[apiIdx + 1]) {
    return segments[apiIdx + 1].toLowerCase();
  }
  return segments[0]?.toLowerCase() || 'system';
}

function normalizeRoutePath(req: AuthRequest): string {
  const routePath = typeof req.route?.path === 'string' ? req.route.path : '';
  return `${req.baseUrl || ''}${routePath || req.path || req.originalUrl || ''}`;
}

function classifyAction(req: AuthRequest, moduleName: string): string {
  const method = (req.method || 'GET').toUpperCase();
  const normalizedPath = normalizeRoutePath(req).toLowerCase();

  if (normalizedPath.includes('/import')) return 'SCRIPT_IMPORT';
  if (normalizedPath.includes('/sync')) return 'WORKSPACE_SYNC';
  if (normalizedPath.includes('/delete-multiple')) return `${moduleName.toUpperCase()}_BULK_DELETE`;
  if (normalizedPath.includes('/execution/run') && method === 'POST') return 'EXECUTION_START';
  if (normalizedPath.includes('/execution/stop') && method === 'POST') return 'EXECUTION_STOP';
  if (normalizedPath.includes('/auth/login') && method === 'POST') return 'AUTH_LOGIN';
  if (normalizedPath.includes('/auth/forgot-password') && method === 'POST') return 'AUTH_FORGOT_PASSWORD';
  if (normalizedPath.includes('/auth/change-password') && method === 'POST') return 'AUTH_CHANGE_PASSWORD';

  if (method === 'GET') return `${moduleName.toUpperCase()}_READ`;
  if (method === 'POST') return `${moduleName.toUpperCase()}_CREATE`;
  if (method === 'PUT' || method === 'PATCH') return `${moduleName.toUpperCase()}_UPDATE`;
  if (method === 'DELETE') return `${moduleName.toUpperCase()}_DELETE`;
  return `${moduleName.toUpperCase()}_${method}`;
}

function classifySeverity(statusCode: number): AppLogSeverity {
  if (statusCode >= 500) return 'ERROR';
  if (statusCode >= 400) return 'WARN';
  return 'INFO';
}

function classifyStatus(statusCode: number): string {
  if (statusCode >= 500) return 'SERVER_ERROR';
  if (statusCode >= 400) return 'CLIENT_ERROR';
  if (statusCode >= 300) return 'REDIRECT';
  return 'SUCCESS';
}

function sanitizeHttpPath(url: string): string {
  const [pathOnly] = String(url || '').split('?');
  return pathOnly || '/';
}

function sanitizeBodyKeys(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];

  return Object.keys(body as Record<string, unknown>)
    .slice(0, 40)
    .map((key) => (SENSITIVE_KEYS.has(key.toLowerCase()) ? `${key}:redacted` : key));
}

function sanitizeQueryKeys(query: AuthRequest['query']): string[] {
  if (!query || typeof query !== 'object') return [];

  return Object.keys(query)
    .slice(0, 40)
    .map((key) => (SENSITIVE_KEYS.has(key.toLowerCase()) ? `${key}:redacted` : key));
}

function shouldSkipAudit(req: AuthRequest): boolean {
  const method = (req.method || '').toUpperCase();
  if (method === 'OPTIONS') return true;

  const rawPath = (req.path || req.originalUrl || '').toLowerCase();
  const path = sanitizeHttpPath(rawPath);

  if (path === '/api/health') return true;

  // Avoid self-generated logging noise from logs screen reads.
  if (method === 'GET') {
    if (path.startsWith('/api/execution/global-logs')) return true;
    if (path.startsWith('/api/logs/modules')) return true;
    if (path.startsWith('/api/logs/actions')) return true;
  }

  // Script mutation endpoints are logged explicitly in scripts routes
  // with richer metadata (script names/counts), so skip generic request logs here.
  if (path.startsWith('/api/scripts/import')) return true;
  if (path.startsWith('/api/scripts/sync')) return true;
  if (path.startsWith('/api/scripts/delete-multiple')) return true;
  if ((method === 'DELETE' || method === 'PUT' || method === 'PATCH') && /^\/api\/scripts\/\d+$/.test(path)) {
    return true;
  }

  return false;
}

export function requestAuditMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  if (shouldSkipAudit(req)) {
    next();
    return;
  }

  const startNs = process.hrtime.bigint();
  const requestIdHeader = req.headers['x-request-id'];
  const requestId = typeof requestIdHeader === 'string' && requestIdHeader.trim()
    ? requestIdHeader.trim().substring(0, 120)
    : randomUUID();

  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  const moduleName = extractModuleFromPath(req.path || req.originalUrl || '');
  const queryKeys = sanitizeQueryKeys(req.query);
  const bodyKeys = sanitizeBodyKeys(req.body);
  const userAgent = String(req.headers['user-agent'] || '').substring(0, 300);

  res.on('finish', () => {
    const durationMs = Number((process.hrtime.bigint() - startNs) / 1000000n);
    const statusCode = res.statusCode || 0;
    const severity = classifySeverity(statusCode);
    const status = classifyStatus(statusCode);
    const action = classifyAction(req, moduleName);
    const routePath = normalizeRoutePath(req);
    const safePath = sanitizeHttpPath(req.originalUrl || req.url || routePath);

    appLogService.enqueue({
      action,
      module: moduleName,
      severity,
      status,
      userId: Number.isInteger(req.userId) ? (req.userId as number) : null,
      message: `${req.method.toUpperCase()} ${routePath} -> ${statusCode} (${durationMs}ms)`,
      requestId,
      httpMethod: req.method.toUpperCase(),
      httpPath: safePath,
      httpStatus: statusCode,
      durationMs,
      metadata: {
        queryKeys,
        bodyKeys,
        ip: req.ip,
        userAgent,
      },
    });
  });

  next();
}
