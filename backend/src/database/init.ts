import { getPool } from './connection';
import { logger } from '../utils/logger';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';

async function initDatabase() {
  const pool = getPool();

  try {
    logger.info('Initializing database...');

    const schemaPath = path.join(__dirname, '../../../database/schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');

    // Split by semicolons and execute each statement
    const statements = schema
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const statement of statements) {
      try {
        await pool.execute(statement);
      } catch (error: any) {
        // Ignore "already exists" errors
        if (error.code !== 'ER_TABLE_EXISTS_ERROR' && error.code !== 'ER_DUP_ENTRY') {
          logger.warn(`Statement warning: ${error.message}`);
        }
      }
    }

    // Create admin user with proper bcrypt hash
    const salt = await bcrypt.genSalt(12);
    const adminHash = await bcrypt.hash('admin123', salt);

    try {
      await pool.execute(
        'UPDATE users SET password_hash = ? WHERE username = ?',
        [adminHash, 'admin']
      );
      logger.info('Admin user password updated.');
    } catch {
      // Admin user may not exist yet
    }

    logger.info('Database initialized successfully!');
    logger.info('Default credentials: admin / admin123');
  } catch (error) {
    logger.error('Database initialization failed:', error);
  } finally {
    await pool.end();
  }
}

initDatabase();
