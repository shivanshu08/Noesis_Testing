import { Router, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { query, execute } from '../database/connection';
import { authenticate, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';

const router = Router();

// Admin-only middleware
const adminOnly = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.userRole !== 'admin') {
    res.status(403).json({ error: 'Forbidden: Admin access required.' });
    return;
  }
  next();
};

router.use(authenticate, adminOnly);

function parseRouteId(idParam: string | string[] | undefined): number | null {
  const raw = Array.isArray(idParam) ? idParam[0] : idParam;
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

router.get('/', async (_req: AuthRequest, res: Response) => {
  try {
    const users = await query('SELECT id, username, email, full_name, role, is_active, avatar_url, last_login, run_count, suites_created, scripts_registered, created_at FROM users ORDER BY created_at DESC');
    res.json(users);
  } catch (error) {
    logger.error('List users error:', error);
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { username, email, password, fullName, role = 'tester', isActive = true, avatarUrl } = req.body;
    if (!username || !password || !fullName) {
      return res.status(400).json({ error: 'Username, password, and full name are required.' });
    }
    const salt = await bcrypt.genSalt(12);
    const passwordHash = await bcrypt.hash(password, salt);
    const result = await execute(
      'INSERT INTO users (username, email, password_hash, full_name, role, is_active, avatar_url) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [username, email || null, passwordHash, fullName, role, isActive, avatarUrl || null]
    );
    logger.info(`Admin created new user: ${username}`);
    res.status(201).json({ message: 'User created successfully.', userId: result.rows[0].id });
  } catch (error: any) {
    if (error.code === '23505') return res.status(409).json({ error: 'Username or email already exists.' });
    res.status(500).json({ error: 'Failed to create user.' });
  }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
    try {
        const userId = parseRouteId(req.params.id);
        if (!userId) {
          res.status(400).json({ error: 'Invalid user ID.' });
          return;
        }

        const { fullName, email, role, isActive, avatarUrl } = req.body;
        await execute('UPDATE users SET full_name = $1, email = $2, role = $3, is_active = $4, avatar_url = $5 WHERE id = $6', [fullName, email || null, role, isActive, avatarUrl || null, userId]);
        res.json({ message: 'User updated successfully.' });
    } catch (error) { res.status(500).json({ error: 'Failed to update user.' }); }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
    const userId = parseRouteId(req.params.id);
    if (!userId) {
      res.status(400).json({ error: 'Invalid user ID.' });
      return;
    }

    if (userId === req.userId) return res.status(400).json({ error: 'You cannot delete your own account.' });
    try {
        await execute('DELETE FROM users WHERE id = $1', [userId]);
        res.status(204).send();
    } catch (error) { res.status(500).json({ error: 'Failed to delete user.' }); }
});

export default router;
