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
  created_by_name: string;
  script_count: number;
  created_at: Date;
}

// GET /api/suites - List all suites
router.get('/', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const suites = await query<SuiteRow>(`
      SELECT ts.*, u.full_name as created_by_name,
        (SELECT COUNT(*) FROM suite_scripts ss WHERE ss.suite_id = ts.id) as script_count
      FROM test_suites ts
      LEFT JOIN users u ON ts.created_by = u.id
      ORDER BY ts.name
    `);
    res.json(suites.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      isParallel: s.is_parallel,
      threadCount: s.thread_count,
      createdBy: s.created_by_name,
      scriptCount: Number(s.script_count),
      createdAt: s.created_at,
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
      createdBy: s.created_by_name,
      createdAt: s.created_at,
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
    const { name, description, scriptIds, isParallel = false, threadCount = 1 } = req.body;

    if (!name || !scriptIds || !Array.isArray(scriptIds) || scriptIds.length === 0) {
      res.status(400).json({ error: 'Name and script IDs are required.' });
      return;
    }

    const client = await getConnection();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        'INSERT INTO test_suites (name, description, is_parallel, thread_count, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [name, description, isParallel, threadCount, req.userId]
      );
      const suiteId = result.rows[0].id;

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
    const { name, description, scriptIds, isParallel, threadCount } = req.body;

    const client = await getConnection();
    try {
      await client.query('BEGIN');

      await client.query(
        'UPDATE test_suites SET name = COALESCE($1, name), description = COALESCE($2, description), is_parallel = COALESCE($3, is_parallel), thread_count = COALESCE($4, thread_count) WHERE id = $5',
        [name, description, isParallel, threadCount, req.params.id]
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
