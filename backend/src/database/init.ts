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

    // Execute the entire schema as one block (PostgreSQL handles IF NOT EXISTS)
    await pool.query(schema);
    logger.info('Schema applied successfully.');

    // Create admin user with proper bcrypt hash
    const salt = await bcrypt.genSalt(12);
    const adminHash = await bcrypt.hash('admin123', salt);

    try {
      await pool.query(
        'UPDATE users SET password_hash = $1 WHERE username = $2',
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
