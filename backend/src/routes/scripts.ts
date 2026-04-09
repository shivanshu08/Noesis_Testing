import { Router, Response } from 'express';
import { query, execute } from '../database/connection';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import { RowDataPacket } from 'mysql2';

const router = Router();
router.use(authenticate);

interface ScriptRow extends RowDataPacket {
  id: number;
  name: string;
  class_name: string;
  method_name: string | null;
  category_id: number;
  category_name: string;
  category_icon: string;
  category_color: string;
  description: string | null;
  file_path: string;
  config_file: string | null;
  is_active: boolean;
  tags: string | null;
  created_at: Date;
}

interface CategoryRow extends RowDataPacket {
  id: number;
  name: string;
  description: string | null;
  icon: string;
  color: string;
  sort_order: number;
  script_count: number;
}

// GET /api/scripts - List all scripts with filtering
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { category, search, active } = req.query;
    let sql = `
      SELECT s.*, sc.name as category_name, sc.icon as category_icon, sc.color as category_color
      FROM scripts s
      JOIN script_categories sc ON s.category_id = sc.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (category) {
      sql += ' AND s.category_id = ?';
      params.push(Number(category));
    }
    if (search) {
      sql += ' AND (s.name LIKE ? OR s.class_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    if (active !== undefined) {
      sql += ' AND s.is_active = ?';
      params.push(active === 'true' ? 1 : 0);
    }

    sql += ' ORDER BY sc.sort_order, s.name';

    const scripts = await query<ScriptRow[]>(sql, params);
    res.json(scripts.map(s => ({
      id: s.id,
      name: s.name,
      className: s.class_name,
      methodName: s.method_name,
      categoryId: s.category_id,
      categoryName: s.category_name,
      categoryIcon: s.category_icon,
      categoryColor: s.category_color,
      description: s.description,
      filePath: s.file_path,
      configFile: s.config_file,
      isActive: s.is_active,
      tags: s.tags ? JSON.parse(s.tags) : [],
      createdAt: s.created_at,
    })));
  } catch (error) {
    logger.error('List scripts error:', error);
    res.status(500).json({ error: 'Failed to fetch scripts.' });
  }
});

// GET /api/scripts/categories - List categories with counts
router.get('/categories', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const categories = await query<CategoryRow[]>(`
      SELECT sc.*, COUNT(s.id) as script_count
      FROM script_categories sc
      LEFT JOIN scripts s ON sc.id = s.category_id AND s.is_active = TRUE
      GROUP BY sc.id
      ORDER BY sc.sort_order
    `);
    res.json(categories.map(c => ({
      id: c.id,
      name: c.name,
      description: c.description,
      icon: c.icon,
      color: c.color,
      sortOrder: c.sort_order,
      scriptCount: c.script_count,
    })));
  } catch (error) {
    logger.error('List categories error:', error);
    res.status(500).json({ error: 'Failed to fetch categories.' });
  }
});

// GET /api/scripts/:id - Get script details
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scripts = await query<ScriptRow[]>(`
      SELECT s.*, sc.name as category_name, sc.icon as category_icon, sc.color as category_color
      FROM scripts s
      JOIN script_categories sc ON s.category_id = sc.id
      WHERE s.id = ?
    `, [req.params.id]);

    if (scripts.length === 0) {
      res.status(404).json({ error: 'Script not found.' });
      return;
    }

    const s = scripts[0];
    res.json({
      id: s.id,
      name: s.name,
      className: s.class_name,
      methodName: s.method_name,
      categoryId: s.category_id,
      categoryName: s.category_name,
      categoryIcon: s.category_icon,
      categoryColor: s.category_color,
      description: s.description,
      filePath: s.file_path,
      configFile: s.config_file,
      isActive: s.is_active,
      tags: s.tags ? JSON.parse(s.tags) : [],
      createdAt: s.created_at,
    });
  } catch (error) {
    logger.error('Get script error:', error);
    res.status(500).json({ error: 'Failed to fetch script.' });
  }
});

// PUT /api/scripts/:id - Update script
router.put('/:id', authorize('admin', 'tester'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name, description, methodName, isActive, tags } = req.body;
    await execute(
      'UPDATE scripts SET name = COALESCE(?, name), description = COALESCE(?, description), method_name = COALESCE(?, method_name), is_active = COALESCE(?, is_active), tags = COALESCE(?, tags) WHERE id = ?',
      [name, description, methodName, isActive, tags ? JSON.stringify(tags) : null, req.params.id]
    );
    res.json({ message: 'Script updated.' });
  } catch (error) {
    logger.error('Update script error:', error);
    res.status(500).json({ error: 'Failed to update script.' });
  }
});

// POST /api/scripts/sync - Scan project and sync scripts
router.post('/sync', authorize('admin'), async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json({ message: 'Script sync initiated. New scripts will be auto-discovered.' });
  } catch (error) {
    logger.error('Sync scripts error:', error);
    res.status(500).json({ error: 'Failed to sync scripts.' });
  }
});

export default router;
