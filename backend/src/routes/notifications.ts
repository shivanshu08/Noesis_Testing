import { Router, Response } from 'express';
import { query, execute } from '../database/connection';
import { authenticate, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';

const router = Router();

// Quick table bootstrap (creates table if it doesn't exist yet)
const initTable = async () => {
  try {
    await execute(`
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        severity VARCHAR(20) NOT NULL,
        summary VARCHAR(255) NOT NULL,
        detail TEXT NOT NULL,
        icon VARCHAR(50) NOT NULL,
        source VARCHAR(100) DEFAULT 'System',
        category VARCHAR(100) DEFAULT 'General',
        action_url VARCHAR(500),
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Add missing columns if they don't exist
    await execute('ALTER TABLE notifications ADD COLUMN IF NOT EXISTS source VARCHAR(100) DEFAULT \'System\'').catch(() => {});
    await execute('ALTER TABLE notifications ADD COLUMN IF NOT EXISTS category VARCHAR(100) DEFAULT \'General\'').catch(() => {});
    await execute('ALTER TABLE notifications ADD COLUMN IF NOT EXISTS action_url VARCHAR(500)').catch(() => {});
    
    // Create index for faster queries
    await execute('CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC)').catch(() => {});
    await execute('CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC)').catch(() => {});
  } catch (e) {
    logger.error('Failed to create notifications table', e);
  }
};
initTable();

// GET /api/notifications - Get notifications
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);

    const notifications = await query(
      `SELECT * FROM notifications 
       WHERE (user_id = $1 OR user_id IS NULL)
       AND created_at >= $2
       ORDER BY created_at DESC 
       LIMIT 200`,
      [req.userId, sinceDate.toISOString()]
    );
    
    console.log(`Fetched ${notifications.length} notifications for user ${req.userId} from last ${days} days`);
    res.json(notifications);
  } catch (error) {
    logger.error('Fetch notifications error:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// POST /api/notifications - Create a new notification
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { severity, summary, detail, icon, source, category, action_url, user_id } = req.body;
    
    // Allow creating global notifications (if user_id is null) or user-specific ones
    const targetUserId = user_id || req.userId;
    
    const result = await query(
      `INSERT INTO notifications (user_id, severity, summary, detail, icon, source, category, action_url) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
       RETURNING id, created_at`,
      [targetUserId, severity, summary, detail, icon, source || 'System', category || 'General', action_url]
    );
    
    logger.info(`Notification created for user ${targetUserId}: ${summary}`);
    res.json(result[0]);
  } catch (error) {
    logger.error('Create notification error:', error);
    res.status(500).json({ error: 'Failed to save notification' });
  }
});

// PUT /api/notifications/:id/read - Mark single as read
router.put('/:id/read', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await execute(
      'UPDATE notifications SET is_read = TRUE WHERE id = $1',
      [req.params.id]
    );
    res.json({ success: true });
  } catch (error) {
    logger.error('Mark as read error:', error);
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

// PUT /api/notifications/read - Mark all as read
router.put('/read', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await execute(
      'UPDATE notifications SET is_read = TRUE WHERE user_id = $1 OR user_id IS NULL',
      [req.userId]
    );
    res.json({ success: true });
  } catch (error) {
    logger.error('Mark all as read error:', error);
    res.status(500).json({ error: 'Failed to update notifications' });
  }
});

// POST /api/notifications/mark-read - Mark multiple as read
router.post('/mark-read', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Invalid IDs' });
    }
    
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    await execute(
      `UPDATE notifications SET is_read = TRUE WHERE id IN (${placeholders})`,
      ids
    );
    
    res.json({ success: true, updated: ids.length });
  } catch (error) {
    logger.error('Mark multiple as read error:', error);
    res.status(500).json({ error: 'Failed to update notifications' });
  }
});

// POST /api/notifications/delete-multiple - Delete multiple notifications
router.post('/delete-multiple', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Invalid IDs' });
    }
    
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    await execute(
      `DELETE FROM notifications WHERE id IN (${placeholders})`,
      ids
    );
    
    logger.info(`Deleted ${ids.length} notifications`);
    res.json({ success: true, deleted: ids.length });
  } catch (error) {
    logger.error('Delete multiple error:', error);
    res.status(500).json({ error: 'Failed to delete notifications' });
  }
});

// DELETE /api/notifications/:id - Delete single notification
router.delete('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await execute(
      'DELETE FROM notifications WHERE id = $1',
      [req.params.id]
    );
    res.json({ success: true });
  } catch (error) {
    logger.error('Delete notification error:', error);
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

// DELETE /api/notifications - Delete all notifications
router.delete('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      'DELETE FROM notifications WHERE user_id = $1 OR user_id IS NULL RETURNING id',
      [req.userId]
    );
    
    logger.info(`Cleared ${result.length} notifications for user ${req.userId}`);
    res.json({ success: true, deleted: result.length });
  } catch (error) {
    logger.error('Clear all notifications error:', error);
    res.status(500).json({ error: 'Failed to clear notifications' });
  }
});

export default router;