import mysql, { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { config } from '../config';
import { logger } from '../utils/logger';

let pool: Pool;

export function getPool(): Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      connectionLimit: config.db.connectionLimit,
      waitForConnections: true,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
    });
    logger.info('MySQL connection pool created');
  }
  return pool;
}

export async function query<T extends RowDataPacket[]>(sql: string, params?: any[]): Promise<T> {
  const [rows] = await getPool().execute<T>(sql, params);
  return rows;
}

export async function execute(sql: string, params?: any[]): Promise<ResultSetHeader> {
  const [result] = await getPool().execute<ResultSetHeader>(sql, params);
  return result;
}

export async function getConnection(): Promise<PoolConnection> {
  return getPool().getConnection();
}

export async function testConnection(): Promise<boolean> {
  try {
    const conn = await getPool().getConnection();
    await conn.ping();
    conn.release();
    logger.info('Database connection successful');
    return true;
  } catch (error) {
    logger.error('Database connection failed:', error);
    return false;
  }
}
