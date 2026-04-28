import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query, execute } from '../database/connection';
import { config } from '../config';
import { authenticate, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';

const router = Router();

interface UserRow {
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

    const users = await query<UserRow>(
      'SELECT * FROM users WHERE (username = $1 OR email = $2) AND is_active = TRUE',
      [username, username]
    );

    if (users.length === 0) {
      res.status(401).json({ error: 'User does not exist.' });
      return;
    }

    const user = users[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }

    await execute('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn as any } // Session timeout from config (default: 24h)
    );

    logger.info(`User logged in: ${user.username}`);

    // Fetch assigned script count for tester users
    let assignedScriptCount: number | undefined;
    if (user.role === 'tester') {
      try {
        const countResult = await query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM script_assignments WHERE user_id = $1',
          [user.id]
        );
        assignedScriptCount = Number(countResult[0]?.count || 0);
      } catch {
        assignedScriptCount = 0;
      }
    }

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        avatarUrl: user.avatar_url,
        ...(assignedScriptCount !== undefined ? { assignedScriptCount } : {}),
      },
    });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ error: 'Login failed.' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const users = await query<UserRow>(
      'SELECT id, username, email, full_name, role, avatar_url, last_login, created_at FROM users WHERE id = $1',
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

    const users = await query<UserRow>('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
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
    await execute('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.userId]);

    res.json({ message: 'Password changed successfully.' });
  } catch (error) {
    logger.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change password.' });
  }
});

// PUT /api/auth/profile
router.put('/profile', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    logger.info(`Received profile update request for user ID: ${req.userId}`);
    const { fullName, email, avatarUrl } = req.body;

    if (!fullName) {
      res.status(400).json({ error: 'Full name is required.' });
      return;
    }

    // Brute-force the DB schema to ensure it can hold massive Base64 strings before updating
    try { await execute('ALTER TABLE users ALTER COLUMN avatar_url TYPE TEXT'); } catch(e) {}

    let sql = 'UPDATE users SET full_name = $1, email = $2';
    const params: any[] = [fullName, email];

    if (avatarUrl !== undefined) {
      sql += ', avatar_url = $3 WHERE id = $4';
      params.push(avatarUrl === '' ? null : avatarUrl, req.userId);
    } else {
      sql += ' WHERE id = $3';
      params.push(req.userId);
    }

    const result = await execute(sql, params);
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'User not found in database.' });
      return;
    }

    logger.info(`User profile updated successfully: ${req.userId}`);
    res.json({ message: 'Profile updated successfully.' });
  } catch (error: any) {
    logger.error('Profile update error:', error);

    // Gracefully handle specific MySQL/PostgreSQL constraint errors
    if (error.code === 'ER_DUP_ENTRY' || error.code === '23505') {
      res.status(409).json({ error: 'This email address is already in use.' });
      return;
    }
    if (error.code === 'ER_DATA_TOO_LONG' || error.code === '22001') {
      res.status(400).json({ error: 'Image is too large. Please use a smaller photo or ask the admin to update the DB avatar column to LONGTEXT.' });
      return;
    }

    // Send the exact database error message to the frontend so it's not a mystery
    res.status(500).json({ error: error.message || 'Failed to update profile.' });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ error: 'Email is required.' });
      return;
    }

    // Check if user exists (in a real app, generate a secure token and send an email via SMTP)
    const users = await query<UserRow>('SELECT id FROM users WHERE email = $1', [email]);
    if (users.length > 0) {
      logger.info(`Password reset requested for: ${email}.`);
    }

    // Always return generic success to prevent email enumeration attacks
    res.json({ message: 'If an account with that email exists, a password reset link has been sent.' });
  } catch (error) {
    logger.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process password reset request.' });
  }
});

export default router;
