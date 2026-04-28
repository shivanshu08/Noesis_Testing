import { execute } from './connection';
import { logger } from '../utils/logger';

function isUndefinedTableError(error: any): boolean {
  return error?.code === '42P01';
}

let userLockoutSchemaReady: Promise<void> | null = null;

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

export async function ensureScriptAssignmentsSchema(): Promise<void> {
  try {
    await execute(`
      CREATE TABLE IF NOT EXISTS script_assignments (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        script_id INT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
        assigned_by INT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
        assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, script_id)
      )
    `);

    await execute('CREATE INDEX IF NOT EXISTS idx_script_assignments_user ON script_assignments(user_id)');
    await execute('CREATE INDEX IF NOT EXISTS idx_script_assignments_script ON script_assignments(script_id)');
    await execute('CREATE INDEX IF NOT EXISTS idx_script_assignments_assigned_by ON script_assignments(assigned_by)');
  } catch (error: any) {
    if (isUndefinedTableError(error)) {
      logger.warn('Skipping script_assignments migration because users or scripts table does not exist yet.');
      return;
    }
    logger.warn(`Script assignments migration failed: ${error?.message || String(error)}`);
  }
}

export async function ensureUserLockoutSchema(): Promise<void> {
  if (userLockoutSchemaReady) return userLockoutSchemaReady;

  userLockoutSchemaReady = ensureUserLockoutSchemaInternal().catch((error) => {
    userLockoutSchemaReady = null;
    throw error;
  });

  return userLockoutSchemaReady;
}

async function ensureUserLockoutSchemaInternal(): Promise<void> {
  try {
    await execute('ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0');
    await execute('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT FALSE');
    await execute('ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP DEFAULT NULL');
    await execute('ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_by INT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL');
    await execute('ALTER TABLE users ADD COLUMN IF NOT EXISTS unlocked_at TIMESTAMP DEFAULT NULL');
    await execute('ALTER TABLE users ADD COLUMN IF NOT EXISTS unlocked_by INT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL');
  } catch (error: any) {
    if (isUndefinedTableError(error)) {
      logger.warn('Skipping users lockout migration because users table does not exist yet.');
      return;
    }
    logger.warn(`Users lockout migration failed: ${error?.message || String(error)}`);
  }
}
