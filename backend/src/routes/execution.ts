import { Router, Response } from 'express';
import { query, execute, getConnection } from '../database/connection';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import { config } from '../config';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { Server as SocketIOServer } from 'socket.io';
import { appLogService } from '../services/appLogService';

const router = Router();
router.use(authenticate);

// Store active processes
const activeProcesses = new Map<number, ChildProcess>();

let io: SocketIOServer | null = null;
export function setSocketIO(socketIO: SocketIOServer) {
  io = socketIO;
}

interface RunRow {
  id: number;
  run_name: string;
  run_type: string;
  suite_id: number | null;
  status: string;
  total_scripts: number;
  passed_count: number;
  failed_count: number;
  error_count: number;
  skipped_count: number;
  duration_ms: number | null;
  environment: string;
  triggered_by: number;
  triggered_by_name: string;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  config_xml: string | null;
}

interface ResultRow {
  id: number;
  run_id: number;
  script_id: number;
  script_name: string;
  class_name: string;
  status: string;
  duration_ms: number | null;
  error_message: string | null;
  log_output: string | null;
  started_at: Date | null;
  completed_at: Date | null;
}

interface LogContext {
  phase: 'start' | 'stdout' | 'stderr' | 'status' | 'system';
  runName: string;
  capturedAt: string;
  lineLength?: number;
  keyword?: string;
  scriptCount?: number;
}

interface UnifiedLogRow {
  id: number;
  runId: number | null;
  resultId: number | null;
  severity: string;
  detail: string;
  detailedDescription: string | null;
  sourceComponent: string | null;
  context: any;
  time: Date;
  source: string;
  runStatus: string | null;
  category: string;
  action: string | null;
  status: string | null;
}

function normalizeActionCode(action: string): string {
  const normalized = String(action || '').trim().toUpperCase();
  if (!normalized) return '';

  const aliases: Record<string, string> = {
    SCRIPTS_DELETE: 'SCRIPT_DELETE',
    SCRIPT_BULK_DELETE: 'SCRIPT_DELETE',
    SCRIPTS_BULK_DELETE: 'SCRIPT_DELETE',
    SCRIPTS_UPDATE: 'SCRIPT_UPDATE',
    SCRIPTS_CREATE: 'SCRIPT_CREATE',
  };

  return aliases[normalized] || normalized;
}

function expandActionFilterAliases(values: string[]): string[] {
  const expanded = new Set<string>();
  const canonical = values.map((value) => normalizeActionCode(value)).filter(Boolean);

  for (const value of canonical) {
    if (value === 'SCRIPT_DELETE') {
      expanded.add('SCRIPT_DELETE');
      expanded.add('SCRIPTS_DELETE');
      expanded.add('SCRIPT_BULK_DELETE');
      expanded.add('SCRIPTS_BULK_DELETE');
      continue;
    }

    if (value === 'SCRIPT_UPDATE') {
      expanded.add('SCRIPT_UPDATE');
      expanded.add('SCRIPTS_UPDATE');
      continue;
    }

    if (value === 'SCRIPT_CREATE') {
      expanded.add('SCRIPT_CREATE');
      expanded.add('SCRIPTS_CREATE');
      continue;
    }

    expanded.add(value);
  }

  return Array.from(expanded);
}

// POST /api/execution/run - Execute scripts
router.post('/run', authorize('admin', 'tester'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { scriptIds, suiteName, environment = 'local' } = req.body;

    if (!scriptIds || !Array.isArray(scriptIds) || scriptIds.length === 0) {
      res.status(400).json({ error: 'At least one script ID is required.' });
      return;
    }

    // Fetch script details
    const placeholders = scriptIds.map((_: any, i: number) => `$${i + 1}`).join(',');
    const scripts = await query<any>(
      `SELECT id, name, class_name, method_name FROM scripts WHERE id IN (${placeholders}) AND is_active = TRUE`,
      scriptIds
    );

    if (scripts.length === 0) {
      res.status(400).json({ error: 'No valid active scripts found.' });
      return;
    }

    const runName = suiteName || `Run ${new Date().toISOString().replace('T', ' ').substring(0, 19)}`;
    const runType = scripts.length === 1 ? 'single' : 'custom';

    // Build TestNG XML dynamically
    const testngXml = buildTestNGXml(runName, scripts);

    // Create execution run record
    const client = await getConnection();
    try {
      await client.query('BEGIN');

      const runResult = await client.query(
        'INSERT INTO execution_runs (run_name, run_type, status, total_scripts, environment, config_xml, triggered_by, started_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING id',
        [runName, runType, 'running', scripts.length, environment, testngXml, req.userId]
      );
      const runId = runResult.rows[0].id;

      // Create result records for each script
      for (const script of scripts) {
        await client.query(
          'INSERT INTO execution_results (run_id, script_id, status) VALUES ($1, $2, $3)',
          [runId, script.id, 'queued']
        );
      }

      await client.query('COMMIT');

      // Start execution in background
      executeScripts(runId, testngXml, scripts, req.userId!, runName);

      res.status(201).json({
        runId,
        message: 'Execution started.',
        totalScripts: scripts.length,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Start execution error:', error);
    res.status(500).json({ error: 'Failed to start execution.' });
  }
});

// POST /api/execution/stop/:runId - Stop a running execution
router.post('/stop/:runId', authorize('admin', 'tester'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const runId = parseInt(req.params.runId as string);
    const proc = activeProcesses.get(runId);

    if (proc) {
      proc.kill('SIGTERM');
      activeProcesses.delete(runId);
    }

    await execute(
      "UPDATE execution_runs SET status = $1, completed_at = NOW() WHERE id = $2 AND status = $3",
      ['stopped', runId, 'running']
    );

    await execute(
      "UPDATE execution_results SET status = $1 WHERE run_id = $2 AND status IN ('queued', 'running')",
      ['skipped', runId]
    );

    await insertExecutionLog(runId, 'WARN', 'Execution was manually stopped by user action.', {
      phase: 'status',
      runName: `Run #${runId}`,
      capturedAt: new Date().toISOString(),
      keyword: 'manual_stop',
    }).catch(() => {});

    await execute(
      `INSERT INTO notifications (user_id, severity, summary, detail, icon, source, category) 
       SELECT triggered_by, $1, $2, $3, $4, $5, $6 FROM execution_runs WHERE id = $7`,
      ['warn', 'Execution Stopped', `Run #${runId} was manually stopped.`, 'pi pi-stop-circle', 'Script Execution', 'Warning', runId]
    ).catch(e => logger.error('Notification error', e));

    if (io) {
      io.to(`run-${runId}`).emit('run-stopped', { runId });
      io.emit('global-run-status', { runId, runName: `Run #${runId}`, status: 'stopped' });
    }

    res.json({ message: 'Execution stopped.' });
  } catch (error) {
    logger.error('Stop execution error:', error);
    res.status(500).json({ error: 'Failed to stop execution.' });
  }
});

// GET /api/execution/runs - List execution runs
router.get('/runs', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { status, limit = '50', offset = '0' } = req.query;
    let sql = `
      SELECT er.*, u.full_name as triggered_by_name
      FROM execution_runs er
      LEFT JOIN users u ON er.triggered_by = u.id
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIdx = 1;

    if (status) {
      sql += ` AND er.status = $${paramIdx++}`;
      params.push(status);
    }

    sql += ` ORDER BY er.created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(Number(limit), Number(offset));

    const runs = await query<RunRow>(sql, params);
    res.json(runs.map(r => ({
      id: r.id,
      runName: r.run_name,
      runType: r.run_type,
      suiteId: r.suite_id,
      status: r.status,
      totalScripts: r.total_scripts,
      passedCount: r.passed_count,
      failedCount: r.failed_count,
      errorCount: r.error_count,
      skippedCount: r.skipped_count,
      durationMs: r.duration_ms,
      environment: r.environment,
      triggeredBy: r.triggered_by_name,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      createdAt: r.created_at,
    })));
  } catch (error) {
    logger.error('List runs error:', error);
    res.status(500).json({ error: 'Failed to fetch runs.' });
  }
});

// GET /api/execution/runs/:id - Get run details with results
router.get('/runs/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const runs = await query<RunRow>(`
      SELECT er.*, u.full_name as triggered_by_name
      FROM execution_runs er
      LEFT JOIN users u ON er.triggered_by = u.id
      WHERE er.id = $1
    `, [req.params.id]);

    if (runs.length === 0) {
      res.status(404).json({ error: 'Run not found.' });
      return;
    }

    const results = await query<ResultRow>(`
      SELECT eres.*, s.name as script_name, s.class_name
      FROM execution_results eres
      JOIN scripts s ON eres.script_id = s.id
      WHERE eres.run_id = $1
      ORDER BY eres.id
    `, [req.params.id]);

    const r = runs[0];
    res.json({
      id: r.id,
      runName: r.run_name,
      runType: r.run_type,
      status: r.status,
      totalScripts: r.total_scripts,
      passedCount: r.passed_count,
      failedCount: r.failed_count,
      errorCount: r.error_count,
      skippedCount: r.skipped_count,
      durationMs: r.duration_ms,
      environment: r.environment,
      configXml: r.config_xml,
      triggeredBy: r.triggered_by_name,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      results: results.map(res => ({
        id: res.id,
        scriptId: res.script_id,
        scriptName: res.script_name,
        className: res.class_name,
        status: res.status,
        durationMs: res.duration_ms,
        errorMessage: res.error_message,
        logOutput: res.log_output,
        startedAt: res.started_at,
        completedAt: res.completed_at,
      })),
    });
  } catch (error) {
    logger.error('Get run details error:', error);
    res.status(500).json({ error: 'Failed to fetch run details.' });
  }
});

// GET /api/execution/stats - Dashboard statistics
router.get('/stats', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [totalScripts] = await query<any>('SELECT COUNT(*) as count FROM scripts WHERE is_active = TRUE');
    const [totalRuns] = await query<any>('SELECT COUNT(*) as count FROM execution_runs');
    const [recentRuns] = await query<any>(
      "SELECT COUNT(*) as count FROM execution_runs WHERE created_at >= NOW() - INTERVAL '7 days'"
    );
    const [passRate] = await query<any>(`
      SELECT
        ROUND(AVG(CASE WHEN status = 'passed' THEN 100 ELSE 0 END), 1) as rate
      FROM execution_runs
      WHERE status IN ('passed', 'failed') AND created_at >= NOW() - INTERVAL '30 days'
    `);
    const runningRuns = await query<any>(
      "SELECT COUNT(*) as count FROM execution_runs WHERE status = 'running'"
    );
    const recentHistory = await query<any>(`
      SELECT created_at::date as date, status, COUNT(*) as count
      FROM execution_runs
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY created_at::date, status
      ORDER BY date
    `);

    const categoryStats = await query<any>(`
      SELECT sc.name, sc.color, COUNT(s.id) as count
      FROM script_categories sc
      LEFT JOIN scripts s ON sc.id = s.category_id AND s.is_active = TRUE
      GROUP BY sc.id, sc.name, sc.color, sc.sort_order
      ORDER BY sc.sort_order
    `);

    res.json({
      totalScripts: totalScripts.count,
      totalRuns: totalRuns.count,
      recentRuns: recentRuns.count,
      passRate: passRate.rate || 0,
      runningCount: runningRuns[0].count,
      recentHistory,
      categoryStats,
    });
  } catch (error) {
    logger.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats.' });
  }
});

// DELETE /api/execution/global-logs/:id - Delete a specific log
router.delete('/global-logs/:id', authorize('admin', 'tester'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const parsedId = Number(req.params.id);
    if (!Number.isFinite(parsedId) || parsedId === 0) {
      res.status(400).json({ error: 'Invalid log ID.' });
      return;
    }

    const normalizedId = Math.trunc(parsedId);
    if (normalizedId < 0) {
      await execute('DELETE FROM app_logs WHERE id = $1', [Math.abs(normalizedId)]);
    } else {
      await execute('DELETE FROM execution_logs WHERE id = $1', [normalizedId]);
    }

    res.json({ success: true, deletedId: normalizedId });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete log.' });
  }
});

// POST /api/execution/global-logs/delete-multiple - Delete multiple logs
router.post('/global-logs/delete-multiple', authorize('admin', 'tester'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: 'Invalid IDs' });
      return;
    }

    const normalizedIds = Array.from(
      new Set(
        ids
          .map((id: unknown) => Number(id))
          .filter((id) => Number.isFinite(id) && id !== 0)
          .map((id) => Math.trunc(id))
      )
    );

    if (normalizedIds.length === 0) {
      res.status(400).json({ error: 'Invalid IDs' });
      return;
    }

    const appLogIds = normalizedIds.filter((id) => id < 0).map((id) => Math.abs(id));
    const executionLogIds = normalizedIds.filter((id) => id > 0);

    if (appLogIds.length > 0) {
      const appPlaceholders = appLogIds.map((_, i) => `$${i + 1}`).join(',');
      await execute(`DELETE FROM app_logs WHERE id IN (${appPlaceholders})`, appLogIds);
    }

    if (executionLogIds.length > 0) {
      const execPlaceholders = executionLogIds.map((_, i) => `$${i + 1}`).join(',');
      await execute(`DELETE FROM execution_logs WHERE id IN (${execPlaceholders})`, executionLogIds);
    }

    res.json({
      success: true,
      deletedCount: normalizedIds.length,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete logs.' });
  }
});

// GET /api/execution/global-logs - Get all execution logs across all runs (up to 1 year)
router.get('/global-logs', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await appLogService.initialize().catch((error) => {
      logger.warn(`Unable to initialize app logs storage before global logs query: ${(error as Error).message}`);
    });

    const daysRaw = Number.parseInt(req.query.days as string, 10);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : null;
    const severity = (req.query.severity as string | undefined)?.toUpperCase();
    const runId = Number.parseInt(req.query.runId as string, 10);
    const search = (req.query.q as string | undefined)?.trim();
    const moduleFilter = (req.query.module as string | undefined)?.trim();
    const actionFilterRaw = (req.query.action as string | undefined)?.trim();
    const statusFilter = (req.query.status as string | undefined)?.trim();
    const parseDateFilter = (value: string | undefined): string | null => {
      const raw = String(value || '').trim();
      if (!raw) return null;

      const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (isoMatch) {
        const year = Number(isoMatch[1]);
        const month = Number(isoMatch[2]) - 1;
        const day = Number(isoMatch[3]);
        const parsedDate = new Date(year, month, day);
        if (Number.isNaN(parsedDate.getTime())) return null;
        return parsedDate.toISOString();
      }

      const dmyMatch = raw.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
      if (dmyMatch) {
        const day = Number(dmyMatch[1]);
        const month = Number(dmyMatch[2]) - 1;
        const year = Number(dmyMatch[3]);
        const parsedDate = new Date(year, month, day);
        if (Number.isNaN(parsedDate.getTime())) return null;
        return parsedDate.toISOString();
      }

      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) return null;
      return parsed.toISOString();
    };
    const from = parseDateFilter(req.query.from as string | undefined);
    const to = parseDateFilter(req.query.to as string | undefined);
    const sortByRaw = (req.query.sortBy as string | undefined)?.trim();
    const sortOrderRaw = (req.query.sortOrder as string | undefined)?.trim().toLowerCase();
    const limitRaw = Number.parseInt(req.query.limit as string, 10);
    const offsetRaw = Number.parseInt(req.query.offset as string, 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 2000) : 500;
    const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

    const sortColumns: Record<string, string> = {
      timestamp: 'l.timestamp',
      severity: 'l.log_level',
      source: 'l.source',
      action: 'COALESCE(l.action, \'\')',
      status: 'COALESCE(l.status, l.run_status, \'\')',
      runId: 'COALESCE(l.run_id, 0)',
    };
    const sortBy = sortByRaw && sortColumns[sortByRaw] ? sortColumns[sortByRaw] : 'l.timestamp';
    const sortOrder = sortOrderRaw === 'asc' ? 'ASC' : 'DESC';

    const whereClauses: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (days !== null) {
      whereClauses.push(`l.timestamp >= NOW() - INTERVAL '1 day' * $${idx++}`);
      params.push(days);
    }

    if (severity && ['INFO', 'WARN', 'ERROR', 'DEBUG'].includes(severity)) {
      whereClauses.push(`l.log_level = $${idx++}`);
      params.push(severity);
    }

    if (Number.isFinite(runId)) {
      whereClauses.push(`l.run_id = $${idx++}`);
      params.push(runId);
    }

    if (search) {
      const searchParamIdx = idx++;
      whereClauses.push(`
        (
          l.message ILIKE $${searchParamIdx}
          OR COALESCE(l.detailed_description, '') ILIKE $${searchParamIdx}
          OR COALESCE(l.source_component, '') ILIKE $${searchParamIdx}
          OR COALESCE(l.source, '') ILIKE $${searchParamIdx}
          OR COALESCE(l.action, '') ILIKE $${searchParamIdx}
          OR COALESCE(l.status, l.run_status, '') ILIKE $${searchParamIdx}
        )
      `);
      params.push(`%${search}%`);
    }

    if (moduleFilter) {
      const moduleParamIdx = idx++;
      whereClauses.push(`(COALESCE(l.source_component, '') ILIKE $${moduleParamIdx} OR COALESCE(l.source, '') ILIKE $${moduleParamIdx})`);
      params.push(`%${moduleFilter}%`);
    }

    const actionFilters = actionFilterRaw
      ? actionFilterRaw
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
    const expandedActionFilters = expandActionFilterAliases(actionFilters);

    if (expandedActionFilters.length > 0) {
      const actionParamIdx = idx++;
      whereClauses.push(`UPPER(COALESCE(l.action, '')) = ANY($${actionParamIdx}::text[])`);
      params.push(expandedActionFilters);
    }

    if (statusFilter) {
      whereClauses.push(`COALESCE(l.status, l.run_status, '') ILIKE $${idx++}`);
      params.push(`%${statusFilter}%`);
    }

    if (from) {
      whereClauses.push(`l.timestamp >= $${idx++}::timestamptz`);
      params.push(from);
    }

    if (to) {
      whereClauses.push(`l.timestamp <= $${idx++}::timestamptz`);
      params.push(to);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const unionSql = `
      WITH unified_logs AS (
        SELECT
          (-al.id)::bigint AS id,
          NULL::int AS run_id,
          NULL::int AS result_id,
          al.severity::text AS log_level,
          al.message AS message,
          al.message AS detailed_description,
          al.module::text AS source_component,
          jsonb_strip_nulls(
            jsonb_build_object(
              'action', al.action,
              'status', al.status,
              'requestId', al.request_id,
              'userId', al.user_id,
              'username', al.username,
              'httpMethod', al.http_method,
              'httpPath', al.http_path,
              'httpStatus', al.http_status,
              'durationMs', al.duration_ms,
              'metadata', al.metadata
            )
          ) AS log_context,
          al.timestamp AS timestamp,
          CASE
            WHEN al.module IS NULL OR al.module = '' THEN 'Application'
            ELSE INITCAP(al.module)
          END::text AS source,
          NULL::text AS run_status,
          'Application'::text AS category,
          al.action::text AS action,
          al.status::text AS status
        FROM app_logs al

        UNION ALL

        SELECT
          el.id::bigint AS id,
          el.run_id AS run_id,
          el.result_id AS result_id,
          el.log_level::text AS log_level,
          el.message AS message,
          COALESCE(el.detailed_description, el.message) AS detailed_description,
          COALESCE(el.source_component, 'execution-engine')::text AS source_component,
          COALESCE(el.log_context, '{}'::jsonb) AS log_context,
          el.timestamp AS timestamp,
          COALESCE(er.run_name, 'System Execution')::text AS source,
          er.status::text AS run_status,
          'Execution'::text AS category,
          NULL::text AS action,
          NULL::text AS status
        FROM execution_logs el
        LEFT JOIN execution_runs er ON el.run_id = er.id
      )
    `;

    const totalRows = await query<{ count: string }>(
      `
      ${unionSql}
      SELECT COUNT(*)::text as count
      FROM unified_logs l
      ${whereSql}
      `,
      params
    );
    const total = Number(totalRows[0]?.count || 0);

    const dataParams = [...params, limit, offset];
    const logs = await query<UnifiedLogRow>(
      `
      ${unionSql}
      SELECT
        l.id,
        l.run_id as "runId",
        l.result_id as "resultId",
        l.log_level as severity,
        l.message as detail,
        l.detailed_description as "detailedDescription",
        l.source_component as "sourceComponent",
        l.log_context as context,
        l.timestamp as time,
        l.source as source,
        l.run_status as "runStatus",
        l.category as category,
        l.action as action,
        l.status as status
      FROM unified_logs l
      ${whereSql}
      ORDER BY ${sortBy} ${sortOrder}
      LIMIT $${idx++} OFFSET $${idx}
      `,
      dataParams
    );

    const transformedLogs = logs.map((log) => ({
      ...log,
      severity: (log.severity || 'info').toLowerCase(),
      summary:
        log.detail && log.detail.length > 120
          ? `${log.detail.substring(0, 120)}...`
          : log.detail || '',
      message: log.detail,
      detailedDescription: log.detailedDescription || log.detail || '',
      sourceComponent: log.sourceComponent || (log.category === 'Application' ? 'application-api' : 'execution-engine'),
      context: log.context || {},
      action: log.action || undefined,
      status: log.status || log.runStatus || undefined,
    }));

    res.json({
      data: transformedLogs,
      meta: {
        total,
        limit,
        offset,
      },
    });
  } catch (error) {
    logger.error('Get global logs error:', error);
    res.status(500).json({ error: 'Failed to fetch global logs.' });
  }
});

// GET /api/execution/logs/:runId - Get execution logs
router.get('/logs/:runId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const logs = await query<any>(
      'SELECT * FROM execution_logs WHERE run_id = $1 ORDER BY timestamp',
      [req.params.runId]
    );
    res.json(logs);
  } catch (error) {
    logger.error('Get logs error:', error);
    res.status(500).json({ error: 'Failed to fetch logs.' });
  }
});

// ---- Helper Functions ----

function buildTestNGXml(suiteName: string, scripts: any[]): string {
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xml += `<!DOCTYPE suite SYSTEM "https://testng.org/testng-1.0.dtd">\n`;
  xml += `<suite name="${escapeXml(suiteName)}" parallel="false">\n`;
  xml += `  <listeners>\n`;
  xml += `    <listener class-name="org.example.utility.CustomHtmlReporter"/>\n`;
  xml += `    <listener class-name="org.example.utility.ExecutionOrderListener"/>\n`;
  xml += `  </listeners>\n`;
  xml += `  <test name="Dynamic Test">\n`;
  xml += `    <classes>\n`;

  for (const script of scripts) {
    xml += `      <class name="${escapeXml(script.class_name)}"`;
    if (script.method_name) {
      xml += `>\n        <methods>\n          <include name="${escapeXml(script.method_name)}"/>\n        </methods>\n      </class>\n`;
    } else {
      xml += `/>\n`;
    }
  }

  xml += `    </classes>\n`;
  xml += `  </test>\n`;
  xml += `</suite>`;
  return xml;
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function sanitizeLogLine(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\r/g, '')
    .trim();
}

function inferKeyword(message: string): string | undefined {
  const upper = message.toUpperCase();
  if (upper.includes('BUILD SUCCESS')) return 'build_success';
  if (upper.includes('BUILD FAILURE')) return 'build_failure';
  if (upper.includes('SKIPPED')) return 'skipped';
  if (upper.includes('FAIL')) return 'failure';
  if (upper.includes('PASS')) return 'pass';
  if (upper.includes('ERROR')) return 'error';
  if (upper.includes('WARN')) return 'warn';
  return undefined;
}

function buildDetailedDescription(
  runId: number,
  logLevel: string,
  message: string,
  context: LogContext
): string {
  const readableLevel = logLevel.toUpperCase();
  const header = `Run #${runId} ${readableLevel} event`;
  const phaseInfo = `Phase: ${context.phase}`;
  const runInfo = `Run Name: ${context.runName}`;
  const keywordInfo = context.keyword ? `Keyword: ${context.keyword}` : '';
  const lengthInfo = typeof context.lineLength === 'number' ? `Line Length: ${context.lineLength}` : '';

  return [header, runInfo, phaseInfo, keywordInfo, lengthInfo, `Message: ${message}`]
    .filter(Boolean)
    .join(' | ')
    .substring(0, 3900);
}

async function insertExecutionLog(
  runId: number,
  logLevel: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG',
  message: string,
  context: LogContext
): Promise<void> {
  const sanitizedMessage = sanitizeLogLine(message).substring(0, 2000);
  const detailedDescription = buildDetailedDescription(runId, logLevel, sanitizedMessage, context);

  await execute(
    `INSERT INTO execution_logs (run_id, log_level, message, detailed_description, source_component, log_context)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [runId, logLevel, sanitizedMessage, detailedDescription, 'execution-engine', JSON.stringify(context)]
  );
}

async function executeScripts(runId: number, testngXml: string, scripts: any[], userId: number, runName: string) {
  const stPath = config.stAutomation.path;
  const fs = await import('fs');
  const tempXmlPath = path.join(stPath, `temp-run-${runId}.xml`);

  try {
    // Write temporary TestNG XML
    fs.writeFileSync(tempXmlPath, testngXml, 'utf8');

    // Log start
    await insertExecutionLog(
      runId,
      'INFO',
      `Execution started for ${scripts.length} script(s)`,
      {
        phase: 'start',
        runName,
        scriptCount: scripts.length,
        capturedAt: new Date().toISOString(),
      }
    );

    if (io) {
      io.to(`run-${runId}`).emit('run-log', {
        runId,
        level: 'INFO',
        message: `Execution started for ${scripts.length} script(s)`,
        timestamp: new Date(),
      });
    }

    // Determine Maven command
    const mvnCmd = process.platform === 'win32' ? 'mvn.cmd' : 'mvn';
    const args = [
      'test',
      `-DsuiteXmlFile=${tempXmlPath}`,
      '-f', path.join(stPath, 'pom.xml'),
    ];

    const child = spawn(mvnCmd, args, {
      cwd: stPath,
      shell: true,
      env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME },
    });

    activeProcesses.set(runId, child);

    let output = '';

    child.stdout?.on('data', async (data: Buffer) => {
      const text = data.toString();
      output += text;

      // Parse and emit real-time logs
      const lines = text.split('\n').filter((l: string) => l.trim());
      for (const line of lines) {
        const cleanLine = sanitizeLogLine(line);
        const logLevel = cleanLine.includes('ERROR') ? 'ERROR' : cleanLine.includes('WARN') ? 'WARN' : 'INFO';

        await insertExecutionLog(runId, logLevel, cleanLine, {
          phase: 'stdout',
          runName,
          capturedAt: new Date().toISOString(),
          lineLength: cleanLine.length,
          keyword: inferKeyword(cleanLine),
        }).catch(() => {});

        if (io) {
          io.to(`run-${runId}`).emit('run-log', {
            runId, level: logLevel, message: line, timestamp: new Date(),
          });
        }
      }
    });

    child.stderr?.on('data', async (data: Buffer) => {
      const text = data.toString();
      output += text;

      const cleanError = sanitizeLogLine(text);
      await insertExecutionLog(runId, 'ERROR', cleanError, {
        phase: 'stderr',
        runName,
        capturedAt: new Date().toISOString(),
        lineLength: cleanError.length,
        keyword: inferKeyword(cleanError),
      }).catch(() => {});

      if (io) {
        io.to(`run-${runId}`).emit('run-log', {
          runId, level: 'ERROR', message: text, timestamp: new Date(),
        });
      }
    });

    child.on('close', async (code: number | null) => {
      activeProcesses.delete(runId);

      // Determine final status
      const finalStatus = code === 0 ? 'passed' : 'failed';

      // Parse test results from output
      const { passed, failed, errors, skipped } = parseTestResults(output);

      await execute(
        'UPDATE execution_runs SET status = $1, passed_count = $2, failed_count = $3, error_count = $4, skipped_count = $5, completed_at = NOW(), duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000 WHERE id = $6',
        [finalStatus, passed, failed, errors, skipped, runId]
      );

      // Update individual results based on output
      await execute(
        `UPDATE execution_results SET status = $1, completed_at = NOW() WHERE run_id = $2 AND status IN ('queued', 'running')`,
        [finalStatus, runId]
      );

      // Save full output
      await execute(
        `UPDATE execution_results SET log_output = $1 WHERE run_id = $2`,
        [output.substring(0, 65000), runId]
      );

      await insertExecutionLog(
        runId,
        finalStatus === 'passed' ? 'INFO' : 'ERROR',
        `Execution completed with status ${finalStatus}. Passed=${passed}, Failed=${failed}, Errors=${errors}, Skipped=${skipped}`,
        {
          phase: 'status',
          runName,
          capturedAt: new Date().toISOString(),
          keyword: finalStatus,
        }
      ).catch(() => {});

      // Log Notification to Database automatically
      const severity = finalStatus === 'passed' ? 'success' : 'error';
      const summary = `Execution ${finalStatus === 'passed' ? 'Passed' : 'Failed'}`;
      const detail = `Suite "${runName}" finished executing with ${passed} passed, ${failed} failed, ${errors} errors, ${skipped} skipped.`;
      const icon = finalStatus === 'passed' ? 'pi pi-check-circle' : 'pi pi-times-circle';
      await execute(
        `INSERT INTO notifications (user_id, severity, summary, detail, icon, source, category) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, severity, summary, detail, icon, 'Script Execution', 'Test Run']
      ).catch(e => logger.error('Notification error', e));

      if (io) {
        io.to(`run-${runId}`).emit('run-completed', {
          runId, status: finalStatus, passed, failed, errors, skipped,
        });
        io.emit('global-run-status', {
          runId, runName, status: finalStatus, passed, failed, errors, skipped,
        });
      }

      // Clean up temp file
      try { fs.unlinkSync(tempXmlPath); } catch {} 

      logger.info(`Run ${runId} completed with status: ${finalStatus}`);
    });

    child.on('error', async (err: Error) => {
      activeProcesses.delete(runId);
      logger.error(`Run ${runId} process error:`, err);

      await execute(
        "UPDATE execution_runs SET status = 'error', completed_at = NOW() WHERE id = $1",
        [runId]
      );

      await insertExecutionLog(runId, 'ERROR', `Execution engine crashed: ${err.message}`, {
        phase: 'status',
        runName,
        capturedAt: new Date().toISOString(),
        keyword: 'engine_error',
      }).catch(() => {});

      // Log Crash Notification
      await execute(
        `INSERT INTO notifications (user_id, severity, summary, detail, icon, source, category) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, 'error', 'Execution Error', `Run "${runName}" failed to start or crashed.`, 'pi pi-exclamation-triangle', 'Script Execution', 'Error']
      ).catch(e => logger.error('Notification error', e));

      if (io) {
        io.to(`run-${runId}`).emit('run-error', { runId, error: err.message });
        io.emit('global-run-status', { runId, runName, status: 'error', error: err.message });
      }
    });

  } catch (error: any) {
    logger.error(`Execute scripts error for run ${runId}:`, error);
    await execute(
      "UPDATE execution_runs SET status = 'error', completed_at = NOW() WHERE id = $1",
      [runId]
    );
    try { (await import('fs')).unlinkSync(tempXmlPath); } catch {}
  }
}

function parseTestResults(output: string): { passed: number; failed: number; errors: number; skipped: number } {
  let passed = 0, failed = 0, errors = 0, skipped = 0;

  // Parse TestNG output: Tests run: X, Failures: Y, Errors: Z, Skipped: W
  const match = output.match(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/);
  if (match) {
    const total = parseInt(match[1]);
    failed = parseInt(match[2]);
    errors = parseInt(match[3]);
    skipped = parseInt(match[4]);
    passed = total - failed - errors - skipped;
  }

  return { passed, failed, errors, skipped };
}

export default router;
