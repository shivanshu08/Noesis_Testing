import { execute } from './connection';
import { logger } from '../utils/logger';

function isUndefinedTableError(error: any): boolean {
  return error?.code === '42P01';
}

export async function ensureTestSuitesSchema(): Promise<void> {
  try {
    await execute('ALTER TABLE test_suites ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT NULL');
  } catch (error: any) {
    if (isUndefinedTableError(error)) {
      logger.warn('Skipping test_suites tags migration because table does not exist yet.');
      return;
    }
    logger.warn(`Test suites migration failed (tags column): ${error?.message || String(error)}`);
  }
}

