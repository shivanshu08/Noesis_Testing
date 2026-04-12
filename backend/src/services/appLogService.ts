import { execute } from '../database/connection';
import { logger } from '../utils/logger';

export type AppLogSeverity = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

interface AppLogEntry {
  timestamp: Date;
  action: string;
  module: string;
  severity: AppLogSeverity;
  status: string;
  userId: number | null;
  username: string | null;
  message: string;
  requestId: string | null;
  httpMethod: string | null;
  httpPath: string | null;
  httpStatus: number | null;
  durationMs: number | null;
  metadata: Record<string, unknown> | null;
}

interface AppLogInput {
  timestamp?: Date;
  action: string;
  module: string;
  severity?: AppLogSeverity;
  status?: string;
  userId?: number | null;
  username?: string | null;
  message: string;
  requestId?: string | null;
  httpMethod?: string | null;
  httpPath?: string | null;
  httpStatus?: number | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown> | null;
}

const MAX_QUEUE_SIZE = 10000;
const MAX_BATCH_SIZE = 200;
const FLUSH_INTERVAL_MS = 250;
const MAX_TEXT_LENGTH = 4000;

function sanitizeText(value: string | null | undefined, fallback = ''): string {
  return String(value || fallback).replace(/\s+/g, ' ').trim().substring(0, MAX_TEXT_LENGTH);
}

function normalizeSeverity(value: string | undefined): AppLogSeverity {
  const upper = String(value || 'INFO').toUpperCase();
  if (upper === 'ERROR') return 'ERROR';
  if (upper === 'WARN' || upper === 'WARNING') return 'WARN';
  if (upper === 'DEBUG') return 'DEBUG';
  return 'INFO';
}

function normalizeNullableInt(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

class AppLogService {
  private queue: AppLogEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private initialized = false;
  private initializingPromise: Promise<void> | null = null;
  private droppedCount = 0;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializingPromise) {
      await this.initializingPromise;
      return;
    }

    this.initializingPromise = this.doInitialize();
    try {
      await this.initializingPromise;
    } finally {
      this.initializingPromise = null;
    }
  }

  private async doInitialize(): Promise<void> {
    if (this.initialized) return;

    await execute(`
      CREATE TABLE IF NOT EXISTS app_logs (
        id BIGSERIAL PRIMARY KEY,
        timestamp TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        action VARCHAR(120) NOT NULL,
        module VARCHAR(120) NOT NULL,
        severity VARCHAR(10) NOT NULL DEFAULT 'INFO',
        status VARCHAR(40) NOT NULL DEFAULT 'SUCCESS',
        user_id INT NULL REFERENCES users(id) ON DELETE SET NULL,
        username VARCHAR(120) NULL,
        message TEXT NOT NULL,
        request_id VARCHAR(120) NULL,
        http_method VARCHAR(10) NULL,
        http_path VARCHAR(600) NULL,
        http_status INT NULL,
        duration_ms INT NULL,
        metadata JSONB NULL
      )
    `);

    await execute('CREATE INDEX IF NOT EXISTS idx_app_logs_timestamp ON app_logs(timestamp DESC)');
    await execute('CREATE INDEX IF NOT EXISTS idx_app_logs_severity_timestamp ON app_logs(severity, timestamp DESC)');
    await execute('CREATE INDEX IF NOT EXISTS idx_app_logs_module_timestamp ON app_logs(module, timestamp DESC)');
    await execute('CREATE INDEX IF NOT EXISTS idx_app_logs_action_timestamp ON app_logs(action, timestamp DESC)');
    await execute('CREATE INDEX IF NOT EXISTS idx_app_logs_user_timestamp ON app_logs(user_id, timestamp DESC)');
    await execute('CREATE INDEX IF NOT EXISTS idx_app_logs_http_status_timestamp ON app_logs(http_status, timestamp DESC)');

    this.initialized = true;
    this.startFlushLoop();
    logger.info('Application logging service initialized');
  }

  enqueue(input: AppLogInput): void {
    if (!this.initialized && !this.initializingPromise) {
      this.initialize().catch((error) => {
        logger.warn(`Centralized logging lazy initialization failed: ${(error as Error).message}`);
      });
    }

    const entry: AppLogEntry = {
      timestamp: input.timestamp instanceof Date ? input.timestamp : new Date(),
      action: sanitizeText(input.action, 'UNKNOWN_ACTION').toUpperCase().substring(0, 120),
      module: sanitizeText(input.module, 'system').toLowerCase().substring(0, 120),
      severity: normalizeSeverity(input.severity),
      status: sanitizeText(input.status, 'SUCCESS').toUpperCase().substring(0, 40),
      userId: normalizeNullableInt(input.userId),
      username: input.username ? sanitizeText(input.username).substring(0, 120) : null,
      message: sanitizeText(input.message, 'No message'),
      requestId: input.requestId ? sanitizeText(input.requestId).substring(0, 120) : null,
      httpMethod: input.httpMethod ? sanitizeText(input.httpMethod).toUpperCase().substring(0, 10) : null,
      httpPath: input.httpPath ? sanitizeText(input.httpPath).substring(0, 600) : null,
      httpStatus: normalizeNullableInt(input.httpStatus),
      durationMs: normalizeNullableInt(input.durationMs),
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : null,
    };

    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.droppedCount += 1;
      if (this.droppedCount === 1 || this.droppedCount % 100 === 0) {
        logger.warn(`Application log queue is full. Dropped entries: ${this.droppedCount}`);
      }
      return;
    }

    this.queue.push(entry);
    if (this.queue.length >= MAX_BATCH_SIZE) {
      this.flush().catch((error) => {
        logger.error('Application log flush error (batch trigger)', error);
      });
      return;
    }

    if (this.queue.length === 1) {
      setImmediate(() => {
        this.flush().catch((error) => {
          logger.error('Application log flush error (immediate trigger)', error);
        });
      });
    }
  }

  logSystemEvent(input: Omit<AppLogInput, 'module'> & { module?: string }): void {
    this.enqueue({
      ...input,
      module: input.module || 'system',
    });
  }

  async flushNow(): Promise<void> {
    while (this.queue.length > 0) {
      await this.flush();
    }
  }

  shutdown(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private startFlushLoop(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flush().catch((error) => {
        logger.error('Application log flush error (timer)', error);
      });
    }, FLUSH_INTERVAL_MS);
  }

  private async flush(): Promise<void> {
    if (!this.initialized || this.flushing || this.queue.length === 0) return;

    this.flushing = true;
    const batch = this.queue.splice(0, MAX_BATCH_SIZE);

    try {
      const valuesSql: string[] = [];
      const params: any[] = [];
      let idx = 1;

      for (const entry of batch) {
        valuesSql.push(
          `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
        );

        params.push(
          entry.timestamp,
          entry.action,
          entry.module,
          entry.severity,
          entry.status,
          entry.userId,
          entry.username,
          entry.message,
          entry.requestId,
          entry.httpMethod,
          entry.httpPath,
          entry.httpStatus,
          entry.durationMs,
          entry.metadata ? JSON.stringify(entry.metadata) : null
        );
      }

      await execute(
        `
        INSERT INTO app_logs (
          timestamp, action, module, severity, status, user_id, username, message,
          request_id, http_method, http_path, http_status, duration_ms, metadata
        )
        VALUES ${valuesSql.join(',')}
        `,
        params
      );
    } catch (error) {
      logger.error('Failed to persist application logs batch', error);
    } finally {
      this.flushing = false;
      if (this.queue.length > 0) {
        setImmediate(() => {
          this.flush().catch((error) => {
            logger.error('Application log flush error (setImmediate)', error);
          });
        });
      }
    }
  }
}

export const appLogService = new AppLogService();
