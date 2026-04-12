import { Router, Response } from 'express';
import { query, execute, getConnection } from '../database/connection';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate);

interface SuiteRow {
  id: number;
  name: string;
  description: string | null;
  is_parallel: boolean;
  thread_count: number;
  tags: string[] | null;
  created_by_name: string;
  script_count: number;
  last_run_status: string | null;
  last_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// GET /api/suites - List all suites with last run info
router.get('/', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const suites = await query<SuiteRow>(`
      SELECT ts.*, u.full_name as created_by_name,
        (SELECT COUNT(*) FROM suite_scripts ss WHERE ss.suite_id = ts.id) as script_count,
        lr.status as last_run_status,
        lr.created_at as last_run_at
      FROM test_suites ts
      LEFT JOIN users u ON ts.created_by = u.id
      LEFT JOIN LATERAL (
        SELECT er.status, er.created_at
        FROM execution_runs er
        WHERE er.suite_id = ts.id
        ORDER BY er.created_at DESC
        LIMIT 1
      ) lr ON true
      ORDER BY ts.name
    `);
    res.json(suites.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      isParallel: s.is_parallel,
      threadCount: s.thread_count,
      tags: s.tags || [],
      createdBy: s.created_by_name,
      scriptCount: Number(s.script_count),
      lastRunStatus: s.last_run_status || null,
      lastRunAt: s.last_run_at || null,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    })));
  } catch (error) {
    logger.error('List suites error:', error);
    res.status(500).json({ error: 'Failed to fetch suites.' });
  }
});

// GET /api/suites/:id - Get suite with scripts
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const suites = await query<SuiteRow>(`
      SELECT ts.*, u.full_name as created_by_name
      FROM test_suites ts LEFT JOIN users u ON ts.created_by = u.id
      WHERE ts.id = $1
    `, [req.params.id]);

    if (suites.length === 0) {
      res.status(404).json({ error: 'Suite not found.' });
      return;
    }

    const scripts = await query<any>(`
      SELECT s.id, s.name, s.class_name, sc.name as category_name, sc.color as category_color, ss.execution_order
      FROM suite_scripts ss
      JOIN scripts s ON ss.script_id = s.id
      JOIN script_categories sc ON s.category_id = sc.id
      WHERE ss.suite_id = $1
      ORDER BY ss.execution_order
    `, [req.params.id]);

    const s = suites[0];
    res.json({
      id: s.id,
      name: s.name,
      description: s.description,
      isParallel: s.is_parallel,
      threadCount: s.thread_count,
      tags: s.tags || [],
      createdBy: s.created_by_name,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      scripts: scripts.map((sc: any) => ({
        id: sc.id,
        name: sc.name,
        className: sc.class_name,
        categoryName: sc.category_name,
        categoryColor: sc.category_color,
        executionOrder: sc.execution_order,
      })),
    });
  } catch (error) {
    logger.error('Get suite error:', error);
    res.status(500).json({ error: 'Failed to fetch suite.' });
  }
});

// POST /api/suites - Create suite
router.post('/', authorize('admin', 'tester'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name, description, scriptIds, isParallel = false, threadCount = 1, tags } = req.body;

    if (!name || !scriptIds || !Array.isArray(scriptIds) || scriptIds.length === 0) {
      res.status(400).json({ error: 'Name and script IDs are required.' });
      return;
    }

    const client = await getConnection();
    try {
      await client.query('BEGIN');

        'INSERT INTO test_suites (name, description, is_parallel, thread_count, tags, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [name, description, isParallel, threadCount, tags ? JSON.stringify(tags) : null, req.userId]
      );
      const suiteId = result.rows[0].id;

      // Increment user suites_created statistic
      await client.query('UPDATE users SET suites_created = suites_created + 1 WHERE id = $1', [req.userId]);

      for (let i = 0; i < scriptIds.length; i++) {
        await client.query(
          'INSERT INTO suite_scripts (suite_id, script_id, execution_order) VALUES ($1, $2, $3)',
          [suiteId, scriptIds[i], i + 1]
        );
      }

      await client.query('COMMIT');
      res.status(201).json({ id: suiteId, message: 'Suite created.' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Create suite error:', error);
    res.status(500).json({ error: 'Failed to create suite.' });
  }
});

// PUT /api/suites/:id - Update suite
router.put('/:id', authorize('admin', 'tester'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name, description, scriptIds, isParallel, threadCount, tags } = req.body;

    const client = await getConnection();
    try {
      await client.query('BEGIN');

      await client.query(
        'UPDATE test_suites SET name = COALESCE($1, name), description = COALESCE($2, description), is_parallel = COALESCE($3, is_parallel), thread_count = COALESCE($4, thread_count), tags = COALESCE($5, tags) WHERE id = $6',
        [name, description, isParallel, threadCount, tags !== undefined ? JSON.stringify(tags) : null, req.params.id]
      );

      if (scriptIds && Array.isArray(scriptIds)) {
        await client.query('DELETE FROM suite_scripts WHERE suite_id = $1', [req.params.id]);
        for (let i = 0; i < scriptIds.length; i++) {
          await client.query(
            'INSERT INTO suite_scripts (suite_id, script_id, execution_order) VALUES ($1, $2, $3)',
            [req.params.id, scriptIds[i], i + 1]
          );
        }
      }

      await client.query('COMMIT');
      res.json({ message: 'Suite updated.' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Update suite error:', error);
    res.status(500).json({ error: 'Failed to update suite.' });
  }
});

// POST /api/suites/:id/duplicate - Duplicate a suite
router.post('/:id/duplicate', authorize('admin', 'tester'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const sourceId = req.params.id;

    // Fetch source suite
    const sources = await query<any>(`SELECT * FROM test_suites WHERE id = $1`, [sourceId]);
    if (sources.length === 0) {
      res.status(404).json({ error: 'Source suite not found.' });
      return;
    }

    const source = sources[0];

    // Fetch source scripts
    const scripts = await query<any>(
      `SELECT script_id, execution_order FROM suite_scripts WHERE suite_id = $1 ORDER BY execution_order`,
      [sourceId]
    );

    const client = await getConnection();
    try {
      await client.query('BEGIN');

      // Generate unique name
      let newName = `Copy of ${source.name}`;
      const existing = await client.query('SELECT id FROM test_suites WHERE name = $1', [newName]);
      if (existing.rows.length > 0) {
        newName = `Copy of ${source.name} (${Date.now()})`;
      }

      const result = await client.query(
        'INSERT INTO test_suites (name, description, is_parallel, thread_count, tags, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [newName, source.description, source.is_parallel, source.thread_count, source.tags ? JSON.stringify(source.tags) : null, req.userId]
      );
      const newId = result.rows[0].id;

      // Increment user suites_created statistic
      await client.query('UPDATE users SET suites_created = suites_created + 1 WHERE id = $1', [req.userId]);

      for (const s of scripts) {
        await client.query(
          'INSERT INTO suite_scripts (suite_id, script_id, execution_order) VALUES ($1, $2, $3)',
          [newId, s.script_id, s.execution_order]
        );
      }

      await client.query('COMMIT');
      res.status(201).json({ id: newId, name: newName, message: 'Suite duplicated successfully.' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Duplicate suite error:', error);
    res.status(500).json({ error: 'Failed to duplicate suite.' });
  }
});

// DELETE /api/suites/:id
router.delete('/:id', authorize('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await execute('DELETE FROM test_suites WHERE id = $1', [req.params.id]);
    res.json({ message: 'Suite deleted.' });
  } catch (error) {
    logger.error('Delete suite error:', error);
    res.status(500).json({ error: 'Failed to delete suite.' });
  }
});

export default router;
