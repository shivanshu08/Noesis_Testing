import { Pool, PoolClient, QueryResult } from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';

let pool: Pool;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      max: config.db.connectionLimit,
    });
    logger.info('PostgreSQL connection pool created');
  }
  return pool;
}

export async function query<T extends Record<string, any> = any>(sql: string, params?: any[]): Promise<T[]> {
  const result = await getPool().query(sql, params);
  return result.rows as T[];
}

export async function execute(sql: string, params?: any[]): Promise<QueryResult> {
  return getPool().query(sql, params);
}

export async function getConnection(): Promise<PoolClient> {
  return getPool().connect();
}

export async function testConnection(): Promise<boolean> {
  try {
    const client = await getPool().connect();
    await client.query('SELECT 1');
    client.release();
    logger.info('Database connection successful');
    return true;
  } catch (error) {
    logger.error('Database connection failed:', error);
    return false;
  }
}
