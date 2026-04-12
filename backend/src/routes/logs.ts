import { Router, Response } from 'express';
import { query } from '../database/connection';
import { authenticate, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import { appLogService } from '../services/appLogService';

const router = Router();
router.use(authenticate);

function normalizeDateFilter(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim();
}

function sanitizeSearch(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.substring(0, 120) : null;
}

async function ensureLogStorage(): Promise<void> {
  try {
    await appLogService.initialize();
  } catch (error) {
    logger.warn(`Unable to ensure centralized log storage: ${(error as Error).message}`);
  }
}

// GET /api/logs/modules - Distinct modules/source components for filter dropdown
router.get('/modules', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await ensureLogStorage();

    const from = normalizeDateFilter(req.query.from);
    const to = normalizeDateFilter(req.query.to);
    const q = sanitizeSearch(req.query.q);

    const whereParts: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (from) {
      whereParts.push(`m.timestamp >= $${idx++}::timestamp`);
      params.push(from);
    }
    if (to) {
      whereParts.push(`m.timestamp <= $${idx++}::timestamp`);
      params.push(to);
    }
    if (q) {
      whereParts.push(`m.module ILIKE $${idx++}`);
      params.push(`%${q}%`);
    }

    const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    const rows = await query<{ value: string; count: string }>(
      `
      WITH modules_union AS (
        SELECT COALESCE(NULLIF(LOWER(module), ''), 'application') AS module, timestamp
        FROM app_logs
        UNION ALL
        SELECT COALESCE(NULLIF(LOWER(source_component), ''), 'execution-engine') AS module, timestamp
        FROM execution_logs
      )
      SELECT
        m.module AS value,
        COUNT(*)::text AS count
      FROM modules_union m
      ${whereSql}
      GROUP BY m.module
      ORDER BY COUNT(*) DESC, m.module ASC
      LIMIT 200
      `,
      params
    );

    const items = rows.map((row) => ({
      value: row.value,
      label: row.value,
      count: Number(row.count || 0),
    }));

    res.json(items);
  } catch (error) {
    logger.error('Get log modules error:', error);
    res.status(500).json({ error: 'Failed to fetch log modules.' });
  }
});

// GET /api/logs/actions - Distinct action names for filter dropdown
router.get('/actions', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await ensureLogStorage();

    const from = normalizeDateFilter(req.query.from);
    const to = normalizeDateFilter(req.query.to);
    const q = sanitizeSearch(req.query.q);
    const moduleFilter = sanitizeSearch(req.query.module);

    const whereParts: string[] = ['al.action IS NOT NULL', `al.action <> ''`];
    const params: any[] = [];
    let idx = 1;

    if (from) {
      whereParts.push(`al.timestamp >= $${idx++}::timestamp`);
      params.push(from);
    }
    if (to) {
      whereParts.push(`al.timestamp <= $${idx++}::timestamp`);
      params.push(to);
    }
    if (q) {
      whereParts.push(`al.action ILIKE $${idx++}`);
      params.push(`%${q}%`);
    }
    if (moduleFilter) {
      whereParts.push(`al.module ILIKE $${idx++}`);
      params.push(`%${moduleFilter}%`);
    }

    const whereSql = `WHERE ${whereParts.join(' AND ')}`;

    const rows = await query<{ value: string; count: string }>(
      `
      SELECT
        al.action AS value,
        COUNT(*)::text AS count
      FROM app_logs al
      ${whereSql}
      GROUP BY al.action
      ORDER BY COUNT(*) DESC, al.action ASC
      LIMIT 300
      `,
      params
    );

    const items = rows.map((row) => ({
      value: row.value,
      label: row.value,
      count: Number(row.count || 0),
    }));

    res.json(items);
  } catch (error) {
    logger.error('Get log actions error:', error);
    res.status(500).json({ error: 'Failed to fetch log actions.' });
  }
});

export default router;
