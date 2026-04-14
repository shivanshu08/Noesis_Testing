import { Router, Response } from 'express';
import { PoolClient } from 'pg';
import { query, getConnection } from '../database/connection';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import { appLogService } from '../services/appLogService';

const router = Router();
router.use(authenticate);

const SUITE_NAME_MAX_LEN = 200;
const COPY_PREFIX = 'Copy of ';
const DUPLICATE_NAME_MAX_ATTEMPTS = 50;

type SuiteAuditSnapshot = {
  id: number;
  name: string;
  description: string | null;
  isParallel: boolean;
  threadCount: number;
  tags: string[];
  scriptIds: number[];
};

function normalizeSuiteName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function getSuiteNameValidationError(name: string): string | null {
  if (!name.trim()) return 'Suite name is required.';
  if (name.length > SUITE_NAME_MAX_LEN) {
    return `Suite name must be ${SUITE_NAME_MAX_LEN} characters or less.`;
  }
  return null;
}

function buildDuplicateSuiteName(sourceName: unknown, attempt: number): string {
  const raw = typeof sourceName === 'string' ? sourceName.trim() : '';
  let baseName = raw || 'Suite';

  // Avoid "Copy of Copy of ..." and normalize numeric suffixes
  baseName = baseName.replace(/^copy of\s+/i, '').replace(/\s+\(\d+\)$/, '').trim();
  if (!baseName) baseName = 'Suite';

  const suffix = attempt === 0 ? '' : ` (${attempt + 1})`;
  const maxBaseLen = SUITE_NAME_MAX_LEN - COPY_PREFIX.length - suffix.length;
  const trimmedBase = (baseName.length > maxBaseLen ? baseName.substring(0, maxBaseLen) : baseName).trimEnd();

  return `${COPY_PREFIX}${trimmedBase}${suffix}`;
}

function arraysEqual<T>(a: T[] | null | undefined, b: T[] | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function normalizeTags(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.filter((t) => typeof t === 'string').map((t) => t.trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((t) => typeof t === 'string').map((t) => t.trim()).filter(Boolean);
      }
    } catch {
      // fallthrough to treating it as a single tag
    }
    return [trimmed];
  }
  return [];
}

async function readSuiteSnapshot(client: PoolClient, suiteId: number): Promise<SuiteAuditSnapshot | null> {
  const suiteRes = await client.query<any>(
    'SELECT id, name, description, is_parallel, thread_count, tags FROM test_suites WHERE id = $1',
    [suiteId]
  );
  if (suiteRes.rows.length === 0) return null;

  const suite = suiteRes.rows[0];
  const scriptsRes = await client.query<{ script_id: number }>(
    'SELECT script_id FROM suite_scripts WHERE suite_id = $1 ORDER BY execution_order',
    [suiteId]
  );

  const scriptIds = scriptsRes.rows
    .map((row) => Number(row.script_id))
    .filter((id) => Number.isFinite(id) && id > 0);

  return {
    id: Number(suite.id),
    name: String(suite.name || ''),
    description: suite.description ?? null,
    isParallel: Boolean(suite.is_parallel),
    threadCount: Number.isFinite(Number(suite.thread_count)) ? Number(suite.thread_count) : 1,
    tags: normalizeTags(suite.tags),
    scriptIds,
  };
}

async function resolveActorName(client: PoolClient, userId: number | undefined): Promise<string | null> {
  if (!Number.isInteger(userId) || !userId) return null;
  try {
    const rows = await client.query<{ username: string | null; full_name: string | null }>(
      'SELECT username, full_name FROM users WHERE id = $1',
      [userId]
    );
    const user = rows.rows[0];
    const fullName = typeof user?.full_name === 'string' ? user.full_name.trim() : '';
    if (fullName) return fullName.substring(0, 120);
    const username = typeof user?.username === 'string' ? user.username.trim() : '';
    if (username) return username.substring(0, 120);
    return null;
  } catch {
    return null;
  }
}

function logSuiteEvent(
  req: AuthRequest,
  event: {
    action: string;
    severity?: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
    status?: string;
    httpStatus?: number;
    message: string;
    username?: string | null;
    metadata?: Record<string, unknown>;
  }
): void {
  appLogService.enqueue({
    action: event.action,
    module: 'suites',
    severity: event.severity || 'INFO',
    status: event.status || 'SUCCESS',
    userId: Number.isInteger(req.userId) ? (req.userId as number) : null,
    username: event.username || null,
    message: event.message,
    requestId: req.requestId || null,
    httpMethod: (req.method || '').toUpperCase() || null,
    httpPath: (req.originalUrl || req.path || '').split('?')[0] || null,
    httpStatus: Number.isInteger(event.httpStatus) ? (event.httpStatus as number) : null,
    metadata: event.metadata || null,
  });
}

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

interface SuiteAuditLogRow {
  id: number;
  timestamp: Date;
  action: string;
  severity: string;
  status: string;
  message: string;
  username: string | null;
  user_full_name: string | null;
  user_username: string | null;
  user_id: number | null;
  request_id: string | null;
  http_method: string | null;
  http_path: string | null;
  http_status: number | null;
  metadata: unknown;
}

function parseAuditMetadata(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function parsePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.trunc(parsed);
  return normalized > 0 ? normalized : null;
}

function extractSuiteAuditNames(metadata: Record<string, unknown> | null): { suiteName: string | null; operation: string | null } {
  if (!metadata) return { suiteName: null, operation: null };

  const suiteNameCandidates = [
    metadata['suiteName'],
    metadata['newSuiteName'],
    metadata['sourceSuiteName'],
  ];

  let suiteName: string | null = null;
  for (const candidate of suiteNameCandidates) {
    const normalized = typeof candidate === 'string' ? candidate.trim() : '';
    if (normalized) {
      suiteName = normalized;
      break;
    }
  }

  const operationRaw = typeof metadata['operation'] === 'string' ? metadata['operation'].trim() : '';
  const operation = operationRaw || null;
  return { suiteName, operation };
}

function extractChangedParts(metadata: Record<string, unknown> | null): string[] {
  if (!metadata) return [];
  const raw = metadata['changedParts'];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
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

// GET /api/suites/audit - Suite audit feed for suites screen
router.get('/audit', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const suiteId = parsePositiveInt(req.query.suiteId);
    const limitRaw = parsePositiveInt(req.query.limit);
    const daysRaw = parsePositiveInt(req.query.days);
    const limit = limitRaw ? Math.min(limitRaw, 1000) : 200;
    const days = daysRaw ? Math.min(daysRaw, 365) : null;

    const actionFilterRaw = String(req.query.action || '').trim();
    const actionCandidates = actionFilterRaw
      .split(',')
      .map((action) => action.trim().toUpperCase())
      .filter(Boolean);
    const allowedActions = new Set(['SUITES_CREATE', 'SUITES_UPDATE', 'SUITES_DELETE']);
    const actions = Array.from(new Set(actionCandidates.filter((action) => allowedActions.has(action))));

    const whereParts: string[] = ['al.module = $1'];
    const params: any[] = ['suites'];
    let idx = 2;

    if (suiteId) {
      const suiteIdText = String(suiteId);
      whereParts.push(
        `(
          COALESCE(al.metadata->>'suiteId', '') = $${idx}
          OR COALESCE(al.metadata->>'newSuiteId', '') = $${idx}
          OR COALESCE(al.metadata->>'sourceSuiteId', '') = $${idx}
        )`
      );
      params.push(suiteIdText);
      idx += 1;
    }

    if (actions.length > 0) {
      whereParts.push(`al.action = ANY($${idx}::text[])`);
      params.push(actions);
      idx += 1;
    }

    if (days) {
      whereParts.push(`al.timestamp >= NOW() - INTERVAL '1 day' * $${idx}`);
      params.push(days);
      idx += 1;
    }

    params.push(limit);

    const rows = await query<SuiteAuditLogRow>(
      `
      SELECT
        al.id,
        al.timestamp,
        al.action,
        al.severity,
        al.status,
        al.message,
        al.username,
        u.full_name AS user_full_name,
        u.username AS user_username,
        al.user_id,
        al.request_id,
        al.http_method,
        al.http_path,
        al.http_status,
        al.metadata
      FROM app_logs al
      LEFT JOIN users u ON al.user_id = u.id
      WHERE ${whereParts.join(' AND ')}
      ORDER BY al.timestamp DESC
      LIMIT $${idx}
      `,
      params
    );

    const feed = rows.map((row) => {
      const metadata = parseAuditMetadata(row.metadata);
      const directSuiteId = parsePositiveInt(metadata?.['suiteId']);
      const newSuiteId = parsePositiveInt(metadata?.['newSuiteId']);
      const sourceSuiteId = parsePositiveInt(metadata?.['sourceSuiteId']);
      const resolvedSuiteId = directSuiteId || newSuiteId || sourceSuiteId || null;
      const changedParts = extractChangedParts(metadata);
      const { suiteName, operation } = extractSuiteAuditNames(metadata);
      const metadataActor = typeof metadata?.['actorName'] === 'string' ? metadata['actorName'].trim() : '';
      const actor = metadataActor
        || (row.user_full_name ? row.user_full_name.trim() : '')
        || (row.username ? row.username.trim() : '')
        || (row.user_username ? row.user_username.trim() : '')
        || (row.user_id ? `User ${row.user_id}` : 'Unknown user');

      return {
        id: row.id,
        timestamp: row.timestamp,
        action: row.action,
        severity: row.severity,
        status: row.status,
        message: row.message,
        actor,
        userId: row.user_id || null,
        suiteId: resolvedSuiteId,
        suiteName,
        operation,
        changedParts,
        requestId: row.request_id || null,
        httpMethod: row.http_method || null,
        httpPath: row.http_path || null,
        httpStatus: Number.isInteger(row.http_status) ? row.http_status : null,
        metadata: metadata || {},
      };
    });

    res.json(feed);
  } catch (error) {
    logger.error('Get suites audit feed error:', error);
    res.status(500).json({ error: 'Failed to fetch suite audit feed.' });
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
    const { name: rawName, description, scriptIds, isParallel = false, threadCount = 1, tags } = req.body;

    const name = normalizeSuiteName(rawName);
    if (!name || !scriptIds || !Array.isArray(scriptIds) || scriptIds.length === 0) {
      res.status(400).json({ error: 'Suite name and at least one script are required.' });
      return;
    }

    const nameError = getSuiteNameValidationError(name);
    if (nameError) {
      res.status(400).json({ error: nameError });
      return;
    }

    const uniqueScriptIds = Array.from(
      new Set(
        scriptIds
          .map((id: any) => Number(id))
          .filter((id: number) => Number.isFinite(id) && id > 0)
      )
    );

    if (uniqueScriptIds.length === 0) {
      res.status(400).json({ error: 'At least one valid script is required.' });
      return;
    }

    const client = await getConnection();
    const username = await resolveActorName(client, req.userId);
    try {
      await client.query('BEGIN');

      const result = await client.query(
        'INSERT INTO test_suites (name, description, is_parallel, thread_count, tags, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [name, description, isParallel, threadCount, tags ? JSON.stringify(tags) : null, req.userId]
      );
      const suiteId = result.rows[0].id;

      // Increment user suites_created statistic
      await client.query('UPDATE users SET suites_created = COALESCE(suites_created, 0) + 1 WHERE id = $1', [req.userId]);

      for (let i = 0; i < uniqueScriptIds.length; i++) {
        await client.query(
          'INSERT INTO suite_scripts (suite_id, script_id, execution_order) VALUES ($1, $2, $3)',
          [suiteId, uniqueScriptIds[i], i + 1]
        );
      }

      await client.query('COMMIT');
      logSuiteEvent(req, {
        action: 'SUITES_CREATE',
        httpStatus: 201,
        message: `Suite created by ${username || (Number.isInteger(req.userId) ? `User ${req.userId}` : 'Unknown user')}: "${name}" (${uniqueScriptIds.length} scripts).`,
        username,
        metadata: {
          actorName: username,
          suiteId,
          suiteName: name,
          description: description ?? null,
          isParallel: Boolean(isParallel),
          threadCount: Number(threadCount || 1),
          tags: Array.isArray(tags) ? tags : [],
          scriptIds: uniqueScriptIds,
          scriptCount: uniqueScriptIds.length,
        },
      });
      res.status(201).json({ id: suiteId, message: 'Suite created.' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error: any) {
    logger.error('Create suite error:', error);
    if (error?.code === '23505') {
      res.status(409).json({ error: 'A suite with this name already exists.' });
      return;
    }
    if (error?.code === '22001') {
      res.status(400).json({ error: `Suite name must be ${SUITE_NAME_MAX_LEN} characters or less.` });
      return;
    }
    if (error?.code === '23503') {
      res.status(400).json({ error: 'One or more scripts no longer exist.' });
      return;
    }
    res.status(500).json({ error: error.message || 'Failed to create suite.' });
  }
});

// PUT /api/suites/:id - Update suite
router.put('/:id', authorize('admin', 'tester'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name: rawName, description, scriptIds, isParallel, threadCount, tags } = req.body;

    const name = rawName === undefined ? null : normalizeSuiteName(rawName);
    if (rawName !== undefined && !name) {
      res.status(400).json({ error: 'Suite name is required.' });
      return;
    }

    if (name) {
      const nameError = getSuiteNameValidationError(name);
      if (nameError) {
        res.status(400).json({ error: nameError });
        return;
      }
    }

    let uniqueScriptIds: number[] | null = null;
    if (scriptIds !== undefined) {
      if (!Array.isArray(scriptIds)) {
        res.status(400).json({ error: 'Script IDs must be an array.' });
        return;
      }

      uniqueScriptIds = Array.from(
        new Set(
          scriptIds
            .map((id: any) => Number(id))
            .filter((id: number) => Number.isFinite(id) && id > 0)
        )
      );

      if (uniqueScriptIds.length === 0) {
        res.status(400).json({ error: 'At least one valid script is required.' });
        return;
      }
    }

    const client = await getConnection();
    const username = await resolveActorName(client, req.userId);
    try {
      await client.query('BEGIN');

      const suiteId = Number(req.params.id);
      const before = await readSuiteSnapshot(client, suiteId);
      if (!before) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Suite not found.' });
        return;
      }

      const updateResult = await client.query(
        'UPDATE test_suites SET name = COALESCE($1, name), description = COALESCE($2, description), is_parallel = COALESCE($3, is_parallel), thread_count = COALESCE($4, thread_count), tags = COALESCE($5, tags) WHERE id = $6',
        [name, description, isParallel, threadCount, tags !== undefined ? JSON.stringify(tags) : null, suiteId]
      );

      if (updateResult.rowCount === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Suite not found.' });
        return;
      }

      if (uniqueScriptIds) {
        await client.query('DELETE FROM suite_scripts WHERE suite_id = $1', [req.params.id]);
        for (let i = 0; i < uniqueScriptIds.length; i++) {
          await client.query(
            'INSERT INTO suite_scripts (suite_id, script_id, execution_order) VALUES ($1, $2, $3)',
            [req.params.id, uniqueScriptIds[i], i + 1]
          );
        }
      }

      const after = await readSuiteSnapshot(client, suiteId);
      await client.query('COMMIT');
      if (after) {
        const changes: Record<string, unknown> = {};
        if (before.name !== after.name) changes.name = { from: before.name, to: after.name };
        if ((before.description || '') !== (after.description || '')) changes.description = { from: before.description, to: after.description };
        if (before.isParallel !== after.isParallel) changes.isParallel = { from: before.isParallel, to: after.isParallel };
        if (before.threadCount !== after.threadCount) changes.threadCount = { from: before.threadCount, to: after.threadCount };
        if (!arraysEqual(before.tags, after.tags)) changes.tags = { from: before.tags, to: after.tags };

        const beforeSet = new Set(before.scriptIds);
        const afterSet = new Set(after.scriptIds);
        const addedScripts = after.scriptIds.filter((id) => !beforeSet.has(id));
        const removedScripts = before.scriptIds.filter((id) => !afterSet.has(id));
        const orderChanged = addedScripts.length === 0 && removedScripts.length === 0 && !arraysEqual(before.scriptIds, after.scriptIds);

        const changedParts: string[] = [];
        if (changes.name) changedParts.push('name');
        if (changes.description) changedParts.push('description');
        if (changes.isParallel) changedParts.push('mode');
        if (changes.threadCount) changedParts.push('thread count');
        if (changes.tags) changedParts.push('tags');
        if (addedScripts.length || removedScripts.length || orderChanged) changedParts.push('scripts');

        const scriptsSummary =
          addedScripts.length || removedScripts.length || orderChanged
            ? `scripts +${addedScripts.length} -${removedScripts.length}${orderChanged ? ' (order changed)' : ''}`
            : null;

        const detailParts: string[] = [];
        if (changes.name) detailParts.push(`name "${before.name}" -> "${after.name}"`);
        if (changes.description) detailParts.push('description updated');
        if (changes.isParallel) {
          detailParts.push(`mode ${before.isParallel ? 'parallel' : 'sequential'} -> ${after.isParallel ? 'parallel' : 'sequential'}`);
        }
        if (changes.threadCount) detailParts.push(`threads ${before.threadCount} -> ${after.threadCount}`);
        if (changes.tags) detailParts.push(`tags ${before.tags.length} -> ${after.tags.length}`);
        if (scriptsSummary) detailParts.push(scriptsSummary);

        logSuiteEvent(req, {
          action: 'SUITES_UPDATE',
          httpStatus: 200,
          message: `Suite updated by ${username || (Number.isInteger(req.userId) ? `User ${req.userId}` : 'Unknown user')}: "${after.name}"${detailParts.length ? ` (${detailParts.join('; ')})` : ''}.`,
          username,
          metadata: {
            actorName: username,
            suiteId: after.id,
            suiteName: after.name,
            changedParts,
            changes,
            scripts: {
              beforeCount: before.scriptIds.length,
              afterCount: after.scriptIds.length,
              addedScriptIds: addedScripts,
              removedScriptIds: removedScripts,
              orderChanged,
            },
            before,
            after,
          },
        });
      }
      res.json({ message: 'Suite updated.' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error: any) {
    logger.error('Update suite error:', error);
    if (error?.code === '23505') {
      res.status(409).json({ error: 'A suite with this name already exists.' });
      return;
    }
    if (error?.code === '22001') {
      res.status(400).json({ error: `Suite name must be ${SUITE_NAME_MAX_LEN} characters or less.` });
      return;
    }
    if (error?.code === '23503') {
      res.status(400).json({ error: 'One or more scripts no longer exist.' });
      return;
    }
    res.status(500).json({ error: error.message || 'Failed to update suite.' });
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
    const username = await resolveActorName(client, req.userId);
    try {
      await client.query('BEGIN');

      let newName: string | null = null;
      let newId: number | null = null;

      const tagsToInsert = typeof source.tags === 'string' ? source.tags : (source.tags ? JSON.stringify(source.tags) : null);

      for (let attempt = 0; attempt < DUPLICATE_NAME_MAX_ATTEMPTS; attempt++) {
        const candidateName = buildDuplicateSuiteName(source.name, attempt);
        const result = await client.query(
          'INSERT INTO test_suites (name, description, is_parallel, thread_count, tags, created_by) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (name) DO NOTHING RETURNING id',
          [candidateName, source.description, source.is_parallel, source.thread_count, tagsToInsert, req.userId]
        );

        if (result.rows.length > 0) {
          newName = candidateName;
          newId = result.rows[0].id;
          break;
        }
      }

      if (!newId || !newName) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'Failed to generate a unique suite name. Please try again.' });
        return;
      }

      // Increment user suites_created statistic
      await client.query('UPDATE users SET suites_created = COALESCE(suites_created, 0) + 1 WHERE id = $1', [req.userId]);

      for (const s of scripts) {
        await client.query(
          'INSERT INTO suite_scripts (suite_id, script_id, execution_order) VALUES ($1, $2, $3)',
          [newId, s.script_id, s.execution_order]
        );
      }

      await client.query('COMMIT');
      logSuiteEvent(req, {
        action: 'SUITES_CREATE',
        httpStatus: 201,
        message: `Suite duplicated by ${username || (Number.isInteger(req.userId) ? `User ${req.userId}` : 'Unknown user')}: "${source.name}" -> "${newName}".`,
        username,
        metadata: {
          actorName: username,
          operation: 'duplicate',
          sourceSuiteId: Number(sourceId),
          sourceSuiteName: source.name,
          newSuiteId: newId,
          newSuiteName: newName,
          scriptCount: scripts.length,
          scriptIds: scripts.map((s: any) => Number(s.script_id)).filter((id: number) => Number.isFinite(id) && id > 0),
        },
      });
      res.status(201).json({ id: newId, name: newName, message: 'Suite duplicated successfully.' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error: any) {
    logger.error('Duplicate suite error:', error);
    if (error?.code === '22001') {
      res.status(400).json({ error: `Suite name must be ${SUITE_NAME_MAX_LEN} characters or less.` });
      return;
    }
    res.status(500).json({ error: error.message || 'Failed to duplicate suite.' });
  }
});

// DELETE /api/suites/:id
router.delete('/:id', authorize('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const suiteId = Number(req.params.id);

    const client = await getConnection();
    const username = await resolveActorName(client, req.userId);
    try {
      await client.query('BEGIN');
      const before = await readSuiteSnapshot(client, suiteId);
      if (!before) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Suite not found.' });
        return;
      }

      await client.query('DELETE FROM test_suites WHERE id = $1', [suiteId]);
      await client.query('COMMIT');

      logSuiteEvent(req, {
        action: 'SUITES_DELETE',
        httpStatus: 200,
        message: `Suite deleted by ${username || (Number.isInteger(req.userId) ? `User ${req.userId}` : 'Unknown user')}: "${before.name}" (${before.scriptIds.length} scripts).`,
        username,
        metadata: {
          actorName: username,
          suiteId: before.id,
          suiteName: before.name,
          scriptIds: before.scriptIds,
          scriptCount: before.scriptIds.length,
          before,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.json({ message: 'Suite deleted.' });
  } catch (error) {
    logger.error('Delete suite error:', error);
    res.status(500).json({ error: 'Failed to delete suite.' });
  }
});

export default router;
