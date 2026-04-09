import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query, execute } from '../database/connection';
import { config } from '../config';
import { authenticate, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import { RowDataPacket } from 'mysql2';

const router = Router();

interface UserRow extends RowDataPacket {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  full_name: string;
  role: string;
  is_active: boolean;
  avatar_url: string | null;
  last_login: Date | null;
  created_at: Date;
}

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required.' });
      return;
    }

    const users = await query<UserRow[]>(
      'SELECT * FROM users WHERE (username = ? OR email = ?) AND is_active = TRUE',
      [username, username]
    );

    if (users.length === 0) {
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }

    const user = users[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }

    await execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn as string }
    );

    logger.info(`User logged in: ${user.username}`);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        avatarUrl: user.avatar_url,
      },
    });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ error: 'Login failed.' });
  }
});

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  try {
    const { username, email, password, fullName } = req.body;

    if (!username || !email || !password || !fullName) {
      res.status(400).json({ error: 'All fields are required.' });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters.' });
      return;
    }

    const existing = await query<UserRow[]>(
      'SELECT id FROM users WHERE username = ? OR email = ?',
      [username, email]
    );

    if (existing.length > 0) {
      res.status(409).json({ error: 'Username or email already exists.' });
      return;
    }

    const salt = await bcrypt.genSalt(12);
    const passwordHash = await bcrypt.hash(password, salt);

    const result = await execute(
      'INSERT INTO users (username, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)',
      [username, email, passwordHash, fullName, 'tester']
    );

    logger.info(`New user registered: ${username}`);

    res.status(201).json({
      message: 'Registration successful.',
      userId: result.insertId,
    });
  } catch (error) {
    logger.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const users = await query<UserRow[]>(
      'SELECT id, username, email, full_name, role, avatar_url, last_login, created_at FROM users WHERE id = ?',
      [req.userId]
    );

    if (users.length === 0) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    const user = users[0];
    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      fullName: user.full_name,
      role: user.role,
      avatarUrl: user.avatar_url,
      lastLogin: user.last_login,
      createdAt: user.created_at,
    });
  } catch (error) {
    logger.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to fetch user.' });
  }
});

// PUT /api/auth/change-password
router.put('/change-password', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword || newPassword.length < 6) {
      res.status(400).json({ error: 'Valid current and new password required (min 6 chars).' });
      return;
    }

    const users = await query<UserRow[]>('SELECT password_hash FROM users WHERE id = ?', [req.userId]);
    if (users.length === 0) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    const valid = await bcrypt.compare(currentPassword, users[0].password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Current password is incorrect.' });
      return;
    }

    const salt = await bcrypt.genSalt(12);
    const hash = await bcrypt.hash(newPassword, salt);
    await execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.userId]);

    res.json({ message: 'Password changed successfully.' });
  } catch (error) {
    logger.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change password.' });
  }
});

export default router;
