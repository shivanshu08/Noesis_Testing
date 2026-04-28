import { Router, Response } from 'express';
import { query, execute, getConnection } from '../database/connection';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import { config } from '../config';
import { spawn, execSync, ChildProcess } from 'child_process';
import path from 'path';
import { Server as SocketIOServer } from 'socket.io';
import { appLogService } from '../services/appLogService';
import { computeNextRun, refreshSchedule, unregisterTask } from '../services/schedulerService';
import { resolveScriptExecutionPlan } from '../services/scriptDependencyService';
import cron from 'node-cron';

const router = Router();
router.use(authenticate);

/**
 * Verifies if all requested scripts are assigned to the tester user.
 * Admins have access to all scripts.
 */
async function checkScriptAssignments(userId: number, role: string, scriptIds: number[]): Promise<boolean> {
  if (role !== 'tester') return true;
  if (!scriptIds || scriptIds.length === 0) return true;

  // Use a set to handle duplicates and normalize to numbers
  const uniqueIds = [...new Set(scriptIds.map(id => Number(id)).filter(id => !isNaN(id) && id > 0))];
  if (uniqueIds.length === 0 && scriptIds.length > 0) return false;
  if (uniqueIds.length === 0) return true;

  const result = await query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM script_assignments WHERE user_id = $1 AND script_id = ANY($2::int[])',
    [userId, uniqueIds]
  );

  return Number(result[0]?.count || 0) === uniqueIds.length;
}

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
  run_metadata: Record<string, unknown> | null;
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

interface RunMetadata {
  executionSource: 'git' | 'local';
  gitRepoUrl: string | null;
  gitBranch: string | null;
  appUrl?: string | null;
  workspacePath: string;
  suiteFilePath: string;
  suiteFileName: string;
  mavenCommand: string;
  reportsDirectory: string;
  certificateHardeningStatus: string;
  certificateHardeningMessage: string;
  startedAt: string;
  completedAt?: string;
  finalStatus?: string;
  exitCode?: number | null;
  resultSummary?: {
    passed: number;
    failed: number;
    errors: number;
    skipped: number;
  };
  artifactCount?: number;
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
    const { scriptIds: scriptIdsRaw, suiteName, environment = 'local' } = req.body;

    if (!Array.isArray(scriptIdsRaw) || scriptIdsRaw.length === 0) {
      res.status(400).json({ error: 'At least one script ID is required.' });
      return;
    }

    const hasAccess = await checkScriptAssignments(req.userId!, req.userRole!, scriptIdsRaw);
    if (!hasAccess) {
      res.status(403).json({ error: 'Access denied: One or more scripts are not assigned to you.' });
      return;
    }

    const dependencyPlan = await resolveScriptExecutionPlan(scriptIdsRaw);

    if (dependencyPlan.requestedScriptIds.length === 0) {
      res.status(400).json({ error: 'At least one valid script ID is required.' });
      return;
    }

    if (dependencyPlan.cyclePath) {
      res.status(400).json({
        error: 'Circular script dependency detected. Please update dependencies before running.',
        cyclePath: dependencyPlan.cyclePath,
      });
      return;
    }

    if (dependencyPlan.missingScriptIds.length > 0) {
      res.status(400).json({
        error: 'One or more scripts (or dependencies) are missing or inactive.',
        missingScriptIds: dependencyPlan.missingScriptIds,
      });
      return;
    }

    if (dependencyPlan.orderedScriptIds.length === 0) {
      res.status(400).json({ error: 'No runnable scripts found for this selection.' });
      return;
    }

    const scriptRows = await query<any>(
      `SELECT id, name, class_name, method_name FROM scripts WHERE id = ANY($1::int[]) AND is_active = TRUE`,
      [dependencyPlan.orderedScriptIds]
    );
    const scriptById = new Map<number, any>(
      scriptRows.map((script) => [Number(script.id), script])
    );
    const scripts = dependencyPlan.orderedScriptIds
      .map((scriptId) => scriptById.get(scriptId))
      .filter(Boolean);

    if (scripts.length === 0) {
      res.status(400).json({ error: 'No valid active scripts found.' });
      return;
    }

    if (scripts.length !== dependencyPlan.orderedScriptIds.length) {
      res.status(400).json({
        error: 'Some scripts could not be resolved for execution.',
        missingScriptIds: dependencyPlan.orderedScriptIds.filter((scriptId) => !scriptById.has(scriptId)),
      });
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

      // Increment user run_count statistic
      await client.query('UPDATE users SET run_count = run_count + 1 WHERE id = $1', [req.userId]);

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
        resolvedScriptIds: dependencyPlan.orderedScriptIds,
        autoIncludedDependencyIds: dependencyPlan.autoIncludedDependencyIds,
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

    if (req.userRole === 'tester') {
      sql += ` AND EXISTS (SELECT 1 FROM execution_results eres WHERE eres.run_id = er.id AND eres.script_id IN (SELECT sa.script_id FROM script_assignments sa WHERE sa.user_id = $${paramIdx++}))`;
      params.push(req.userId!);
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
      runMetadata: r.run_metadata,
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

    if (req.userRole === 'tester') {
      const assignmentCheck = await query<{ count: string }>(
        `SELECT COUNT(*)::text as count FROM execution_results eres
         WHERE eres.run_id = $1
         AND eres.script_id IN (SELECT sa.script_id FROM script_assignments sa WHERE sa.user_id = $2)`,
        [req.params.id, req.userId!]
      );
      if (Number(assignmentCheck[0]?.count || 0) === 0) {
        res.status(403).json({ error: 'Access denied: You are not assigned to any scripts in this execution run.' });
        return;
      }
    }

    const results = await query<ResultRow>(`
      SELECT eres.*, s.name as script_name, s.class_name
      FROM execution_results eres
      JOIN scripts s ON eres.script_id = s.id
      WHERE eres.run_id = $1
      ORDER BY eres.id
    `, [req.params.id]);

    const r = runs[0];
    const runMetadata: Record<string, unknown> = r.run_metadata && typeof r.run_metadata === 'object'
      ? { ...(r.run_metadata as Record<string, unknown>) }
      : {};

    const rawAppUrl = runMetadata.appUrl;
    const existingAppUrl = typeof rawAppUrl === 'string' && rawAppUrl.trim()
      ? rawAppUrl.trim()
      : null;

    if (!existingAppUrl) {
      let derivedAppUrl: string | null = resolveExecutionAppUrlFromLogOutput(results);

      const rawWorkspacePath = runMetadata.workspacePath;
      const workspacePath = typeof rawWorkspacePath === 'string' ? rawWorkspacePath : null;

      if (!derivedAppUrl) {
        const rawReportsDirectory = runMetadata.reportsDirectory;
        const reportsDirectory = typeof rawReportsDirectory === 'string' ? rawReportsDirectory : null;
        const reportsWorkspacePath = resolveWorkspaceRootFromReportsDirectory(reportsDirectory);

        const rawSuiteFilePath = runMetadata.suiteFilePath;
        const suiteFilePath = typeof rawSuiteFilePath === 'string' ? rawSuiteFilePath : null;
        const suiteWorkspacePath = suiteFilePath ? path.dirname(suiteFilePath) : null;

        const automationRoot = resolveFirstExistingPath([
          workspacePath,
          reportsWorkspacePath,
          suiteWorkspacePath,
          config.stAutomation.gitCachePath,
          path.join(process.cwd(), '.cache', 'automation-testing-repo'),
          path.join(process.cwd(), 'backend', '.cache', 'automation-testing-repo'),
          config.stAutomation.path,
        ]);

        if (automationRoot) {
          const classNamesFromResults = results.map((res) => res.class_name).filter(Boolean);
          const classNamesFromXml = extractTestClassNamesFromTestNgXml(r.config_xml);
          const classNames = Array.from(new Set([...classNamesFromResults, ...classNamesFromXml]));

          derivedAppUrl = resolveExecutionAppUrlFromTestClasses(r.id, automationRoot, classNames);

          if (!derivedAppUrl) {
            derivedAppUrl = resolveExecutionAppUrlFromWorkspaceResources(r.id, automationRoot);
          }
        }
      }

      if (derivedAppUrl) {
        runMetadata.appUrl = derivedAppUrl;
        await persistRunMetadata(r.id, runMetadata);
      }
    }

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
      runMetadata,
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
    const isTester = _req.userRole === 'tester';
    const userId = _req.userId!;

    const totalScripts = await query<any>(
      `SELECT COUNT(*) as count FROM scripts WHERE is_active = TRUE ${isTester ? 'AND id IN (SELECT script_id FROM script_assignments WHERE user_id = $1)' : ''}`,
      isTester ? [userId] : []
    );

    const runFilter = isTester
      ? `WHERE EXISTS (SELECT 1 FROM execution_results eres WHERE eres.run_id = er.id AND eres.script_id IN (SELECT sa.script_id FROM script_assignments sa WHERE sa.user_id = $1))`
      : '';
    const runParams = isTester ? [userId] : [];

    const totalRuns = await query<any>(
      `SELECT COUNT(*) as count FROM execution_runs er ${runFilter}`,
      runParams
    );

    const recentRuns = await query<any>(
      `SELECT COUNT(*) as count FROM execution_runs er ${runFilter ? runFilter + ' AND' : 'WHERE'} er.created_at >= NOW() - INTERVAL '7 days'`,
      runParams
    );

    const passRate = await query<any>(
      `SELECT ROUND(AVG(CASE WHEN er.status = 'passed' THEN 100 ELSE 0 END), 1) as rate
       FROM execution_runs er
       ${runFilter ? runFilter + ' AND' : 'WHERE'} er.status IN ('passed', 'failed') AND er.created_at >= NOW() - INTERVAL '30 days'`,
      runParams
    );

    const runningRuns = await query<any>(
      `SELECT COUNT(*) as count FROM execution_runs er ${runFilter ? runFilter + ' AND' : 'WHERE'} er.status = 'running'`,
      runParams
    );

    const recentHistory = await query<any>(`
      SELECT
        er.created_at::date as date,
        'passed' as status,
        SUM(er.passed_count)::int as count
      FROM execution_runs er
      ${runFilter ? runFilter + ' AND' : 'WHERE'} er.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY er.created_at::date

      UNION ALL

      SELECT
        er.created_at::date as date,
        'failed' as status,
        SUM(er.failed_count + er.error_count)::int as count
      FROM execution_runs er
      ${runFilter ? runFilter + ' AND' : 'WHERE'} er.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY er.created_at::date

      ORDER BY date
    `, runParams);

    const categoryStats = await query<any>(`
      SELECT sc.name, sc.color, COUNT(s.id) as count
      FROM script_categories sc
      LEFT JOIN scripts s ON sc.id = s.category_id AND s.is_active = TRUE
      ${isTester ? 'AND s.id IN (SELECT sa.script_id FROM script_assignments sa WHERE sa.user_id = $1)' : ''}
      GROUP BY sc.id, sc.name, sc.color, sc.sort_order
      ORDER BY sc.sort_order
    `, isTester ? [userId] : []);

    res.json({
      totalScripts: totalScripts[0].count,
      totalRuns: totalRuns[0].count,
      recentRuns: recentRuns[0].count,
      passRate: passRate[0].rate || 0,
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

    if (req.userRole === 'tester') {
      whereClauses.push(`
        (
          l.run_id IS NULL
          OR EXISTS (
            SELECT 1 FROM execution_results eres
            WHERE eres.run_id = l.run_id
            AND eres.script_id IN (SELECT sa.script_id FROM script_assignments sa WHERE sa.user_id = $${idx++})
          )
        )
      `);
      params.push(req.userId!);
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
        WHERE al.action != 'SCRIPT_ASSIGNMENT_UPDATE'

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

    const summaryRows = await query<any>(
      `
      ${unionSql}
      SELECT
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE l.log_level = 'ERROR')::int as "errorCount",
        COUNT(*) FILTER (WHERE l.log_level = 'WARN')::int as "warnCount",
        COUNT(*) FILTER (WHERE l.log_level = 'INFO')::int as "infoCount",
        COUNT(*) FILTER (WHERE l.log_level = 'DEBUG')::int as "debugCount",
        COUNT(DISTINCT l.run_id)::int as "uniqueRunCount"
      FROM unified_logs l
      ${whereSql}
      `,
      params
    );
    const summary = summaryRows[0] || {
      total: 0,
      errorCount: 0,
      warnCount: 0,
      infoCount: 0,
      debugCount: 0,
      uniqueRunCount: 0,
    };
    const total = summary.total;

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
      summary,
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
    res.json(logs.map((log) => ({
      runId: log.run_id,
      level: log.log_level,
      message: log.message,
      timestamp: log.timestamp,
    })));
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
  xml += `    <listener class-name="org.example.utility.PreExecutionReviewListener"/>\n`;
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

function extractTestClassNamesFromTestNgXml(testngXml: unknown): string[] {
  if (typeof testngXml !== 'string') return [];
  const value = testngXml.trim();
  if (!value) return [];

  const classNames: string[] = [];
  const regex = /<class\b[^>]*\bname="([^"]+)"[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value)) !== null) {
    const name = match[1]?.trim();
    if (name) classNames.push(name);
  }
  return classNames;
}

function resolveFirstExistingPath(candidates: Array<string | null | undefined>): string | null {
  const fs = require('fs');

  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = String(candidate).trim();
    if (!trimmed) continue;
    if (fs.existsSync(trimmed)) return trimmed;
  }

  return null;
}

function resolveWorkspaceRootFromReportsDirectory(reportsDirectory: string | null): string | null {
  if (!reportsDirectory) return null;
  const trimmed = String(reportsDirectory).trim();
  if (!trimmed) return null;

  const normalized = path.normalize(trimmed);
  const parts = normalized.split(path.sep);
  const targetIndex = parts.findIndex((part) => String(part || '').toLowerCase() === 'target');
  if (targetIndex > 0) {
    const prefix = parts.slice(0, targetIndex).join(path.sep);
    if (prefix) return prefix;
  }

  try {
    return path.dirname(path.dirname(normalized));
  } catch {
    return null;
  }
}

function resolveJavaSourcePath(stPath: string, sourceSet: 'main' | 'test', className: string): string {
  const relativePath = className.replace(/\./g, path.sep) + '.java';
  return path.join(stPath, 'src', sourceSet, 'java', relativePath);
}

function findJavaSourcePath(stPath: string, className: string, preferredSourceSets: Array<'main' | 'test'>): string | null {
  const fs = require('fs');
  if (!stPath || !className) return null;

  for (const sourceSet of preferredSourceSets) {
    const candidatePath = resolveJavaSourcePath(stPath, sourceSet, className);
    if (fs.existsSync(candidatePath)) return candidatePath;
  }

  return null;
}

function buildJavaImportMap(javaSource: string): Map<string, string> {
  const map = new Map<string, string>();
  const importRegex = /^\s*import\s+([A-Za-z0-9_.]+)\s*;\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(javaSource)) !== null) {
    const fullName = match[1];
    const simpleName = fullName.split('.').pop() || fullName;
    map.set(simpleName, fullName);
  }
  return map;
}

function extractConfigClassNameFromTestSource(javaSource: string): string | null {
  const patterns = [
    /\b([A-Za-z_][A-Za-z0-9_]*Config)\s*\.\s*getInstance\s*\(/,
    /\b([A-Za-z_][A-Za-z0-9_]*Config)\s*\.\s*forEnvironment\s*\(/,
  ];

  for (const pattern of patterns) {
    const match = javaSource.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

function extractConfigJsonResourcePath(configSource: string): string | null {
  const directLiteral = configSource.match(
    /ConfigurationLoader\.loadConfiguration\([\s\S]*?,\s*\"([^\"]+\.json)\"\s*,/m
  );
  if (directLiteral?.[1]) return directLiteral[1];

  const varMatch = configSource.match(
    /ConfigurationLoader\.loadConfiguration\([\s\S]*?,\s*([A-Za-z_][A-Za-z0-9_]*)\s*,/m
  );
  if (varMatch?.[1]) {
    const varName = varMatch[1];
    const assignRegex = new RegExp(`\\b${varName}\\b\\s*=\\s*\"([^\"]+\\.json)\"`);
    const assignMatch = configSource.match(assignRegex);
    if (assignMatch?.[1]) return assignMatch[1];
  }

  const anyJsonLiteral = configSource.match(/\"([^\"]+\.json)\"/m);
  if (anyJsonLiteral?.[1]) return anyJsonLiteral[1];

  return null;
}

function findAppUrlInJson(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAppUrlInJson(item);
      if (found) return found;
    }
    return null;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, child] of entries) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === 'appurl' || normalizedKey === 'app_url') {
      if (typeof child === 'string' && child.trim()) return child.trim();
    }
  }

  for (const [, child] of entries) {
    const found = findAppUrlInJson(child);
    if (found) return found;
  }

  return null;
}

function resolveAppUrlFromConfigResource(stPath: string, configResourcePath: string): string | null {
  const fs = require('fs');
  const trimmedPath = String(configResourcePath || '').trim();
  if (!stPath || !trimmedPath) return null;

  const relativeResourcePath = trimmedPath
    .replace(/^[\\/]+/, '')
    .replace(/\//g, path.sep)
    .replace(/^src[\\/]+main[\\/]+resources[\\/]+/i, '')
    .replace(/^src[\\/]+test[\\/]+resources[\\/]+/i, '');

  const candidatePaths: Array<string | null> = [
    /^[A-Za-z]:[\\/]/.test(trimmedPath) || trimmedPath.startsWith('\\\\') ? trimmedPath : null,
    path.join(stPath, 'src', 'main', 'resources', relativeResourcePath),
    path.join(stPath, 'src', 'test', 'resources', relativeResourcePath),
  ];

  for (const candidate of candidatePaths) {
    if (!candidate || !fs.existsSync(candidate)) continue;

    try {
      const content = fs.readFileSync(candidate, 'utf8');
      try {
        const parsed = JSON.parse(content);
        const found = findAppUrlInJson(parsed);
        if (found) return found;
      } catch {
        const match = content.match(/\"appUrl\"\s*:\s*\"([^\"]+)\"/i);
        const found = match?.[1]?.trim();
        if (found) return found;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function sanitizeUrlCandidate(value: string): string | null {
  const trimmed = String(value || '').trim().replace(/^['"]+|['"]+$/g, '');
  if (!trimmed) return null;

  const cleaned = trimmed.replace(/[)\]}>.,;:]+$/g, '');
  if (!/^https?:\/\//i.test(cleaned)) return null;
  return cleaned;
}

function scoreUrlCandidate(url: string): number {
  const normalized = String(url || '').toLowerCase();
  let score = 0;
  if (normalized.startsWith('https://')) score += 5;
  if (normalized.includes('sandbox')) score += 15;
  if (normalized.includes('dev')) score += 10;
  if (normalized.includes('val')) score += 12;
  if (normalized.includes('drogevate.com')) score += 10;
  if (normalized.includes('localhost') || normalized.includes('127.0.0.1')) score -= 50;
  if (normalized.includes('/api/')) score -= 10;
  return score;
}

function pickBestUrlCandidate(urls: string[]): string | null {
  const cleaned = urls.map(sanitizeUrlCandidate).filter(Boolean) as string[];
  if (cleaned.length === 0) return null;

  const frequency = new Map<string, { url: string; count: number }>();
  for (const url of cleaned) {
    const key = url.trim().replace(/\/+$/, '').toLowerCase();
    const existing = frequency.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    frequency.set(key, { url: url.trim(), count: 1 });
  }

  let best: { url: string; count: number } | null = null;
  for (const entry of frequency.values()) {
    if (!best) {
      best = entry;
      continue;
    }

    if (entry.count > best.count) {
      best = entry;
      continue;
    }

    if (entry.count === best.count && scoreUrlCandidate(entry.url) > scoreUrlCandidate(best.url)) {
      best = entry;
    }
  }

  return best?.url || null;
}

function resolveExecutionAppUrlFromLogOutput(results: ResultRow[]): string | null {
  if (!Array.isArray(results) || results.length === 0) return null;

  const uniqueOutputs: string[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    if (typeof result.log_output !== 'string') continue;
    const trimmed = result.log_output.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    uniqueOutputs.push(trimmed);
    if (uniqueOutputs.length >= 3) break;
  }

  const combinedText = uniqueOutputs.join('\n').slice(0, 250_000);

  if (!combinedText) return null;

  const urls: string[] = [];
  const regex = /https?:\/\/[^\s"'<>]+/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(combinedText)) !== null) {
    urls.push(match[0]);
  }

  return pickBestUrlCandidate(urls);
}

function resolveExecutionAppUrlFromWorkspaceResources(runId: number, stPath: string): string | null {
  const fs = require('fs');
  if (!stPath || !fs.existsSync(stPath)) return null;

  const resourceRoots: string[] = [
    path.join(stPath, 'src', 'main', 'resources'),
    path.join(stPath, 'src', 'test', 'resources'),
  ].filter((candidate) => fs.existsSync(candidate));

  if (resourceRoots.length === 0) return null;

  const urls: string[] = [];
  const skipDirNames = new Set(['.git', 'target', 'node_modules', 'build', 'dist', 'out', '.idea', '.vscode']);
  const stack: string[] = [...resourceRoots];

  while (stack.length > 0) {
    const currentDir = stack.pop() as string;
    let entries: any[] = [];

    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry?.isDirectory?.()) {
        if (skipDirNames.has(entry.name)) continue;
        stack.push(path.join(currentDir, entry.name));
        continue;
      }

      if (!entry?.isFile?.()) continue;
      if (!String(entry.name || '').toLowerCase().endsWith('.json')) continue;

      const filePath = path.join(currentDir, entry.name);

      try {
        const stat = fs.statSync(filePath);
        if (typeof stat?.size === 'number' && stat.size > 2_000_000) continue;
      } catch {
        continue;
      }

      let content = '';
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      try {
        const parsed = JSON.parse(content);
        const found = findAppUrlInJson(parsed);
        if (found) urls.push(found);
      } catch {
        const match = content.match(/\"appUrl\"\s*:\s*\"([^\"]+)\"/i);
        const found = match?.[1]?.trim();
        if (found) urls.push(found);
      }
    }
  }

  if (urls.length === 0) {
    logger.warn(`Run ${runId}: No appUrl candidates found under workspace resources.`);
    return null;
  }

  return pickBestUrlCandidate(urls);
}

function resolveExecutionAppUrlFromTestClasses(runId: number, stPath: string, testClassNames: string[]): string | null {
  const fs = require('fs');
  if (!stPath || !fs.existsSync(stPath) || !Array.isArray(testClassNames) || testClassNames.length === 0) return null;

  const uniqueClassNames = Array.from(new Set(testClassNames.filter(Boolean)));
  const searchRoots: string[] = [
    path.join(stPath, 'src', 'test', 'java'),
    path.join(stPath, 'src', 'main', 'java'),
  ].filter((candidate) => fs.existsSync(candidate));

  const skipDirNames = new Set(['.git', 'target', 'node_modules', 'build', 'dist', 'out', '.idea', '.vscode']);
  const fileNameSearchCache = new Map<string, string | null>();

  const findFileByName = (root: string, targetFileName: string): string | null => {
    const stack: string[] = [root];

    while (stack.length > 0) {
      const currentDir = stack.pop() as string;
      let entries: any[] = [];

      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry?.isDirectory?.()) {
          if (skipDirNames.has(entry.name)) continue;
          stack.push(path.join(currentDir, entry.name));
          continue;
        }

        if (entry?.isFile?.() && entry.name === targetFileName) {
          return path.join(currentDir, entry.name);
        }
      }
    }

    return null;
  };

  const resolveTestClassPath = (className: string): string | null => {
    const directPath = findJavaSourcePath(stPath, className, ['test', 'main']);
    if (directPath) return directPath;

    const simpleName = String(className || '').split('.').pop()?.replace(/\.java$/i, '').trim();
    if (!simpleName) return null;

    const cacheKey = simpleName.toLowerCase();
    if (fileNameSearchCache.has(cacheKey)) {
      return fileNameSearchCache.get(cacheKey) || null;
    }

    const targetFileName = `${simpleName}.java`;
    for (const root of searchRoots) {
      const found = findFileByName(root, targetFileName);
      if (found) {
        fileNameSearchCache.set(cacheKey, found);
        return found;
      }
    }

    fileNameSearchCache.set(cacheKey, null);
    return null;
  };

  for (const testClassName of uniqueClassNames) {
    const testClassPath = resolveTestClassPath(testClassName);
    if (!testClassPath) continue;

    let testSource = '';
    try {
      testSource = fs.readFileSync(testClassPath, 'utf8');
    } catch (error: any) {
      logger.warn(`Run ${runId}: Failed to read test source ${testClassPath}: ${error?.message || error}`);
      continue;
    }

    const configClassSimpleName = extractConfigClassNameFromTestSource(testSource);

    // Fallback: some scripts may load configuration JSON directly without a dedicated *Config class.
    const inlineConfigJsonPath = extractConfigJsonResourcePath(testSource);
    if (inlineConfigJsonPath) {
      const inlineAppUrl = resolveAppUrlFromConfigResource(stPath, inlineConfigJsonPath);
      if (inlineAppUrl) return inlineAppUrl;
    }

    if (!configClassSimpleName) continue;

    const importMap = buildJavaImportMap(testSource);
    const candidates: string[] = [];
    const importedFullName = importMap.get(configClassSimpleName);
    if (importedFullName) candidates.push(importedFullName);
    candidates.push(`org.example.config.${configClassSimpleName}`);
    candidates.push(`org.example.config.manual.${configClassSimpleName}`);

    for (const fullConfigClassName of candidates) {
      const configClassPath = findJavaSourcePath(stPath, fullConfigClassName, ['main', 'test']);
      if (!configClassPath) continue;

      let configSource = '';
      try {
        configSource = fs.readFileSync(configClassPath, 'utf8');
      } catch {
        continue;
      }

      const configJsonResourcePath = extractConfigJsonResourcePath(configSource);
      if (!configJsonResourcePath) continue;

      const appUrl = resolveAppUrlFromConfigResource(stPath, configJsonResourcePath);
      if (appUrl) return appUrl;
    }
  }

  return null;
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

async function persistRunMetadata(runId: number, metadata: Record<string, unknown> | RunMetadata): Promise<void> {
  try {
    await execute(
      `UPDATE execution_runs SET run_metadata = $1 WHERE id = $2`,
      [JSON.stringify(metadata), runId]
    );
  } catch (error: any) {
    const message = String(error?.message || '');
    if (message.toLowerCase().includes('run_metadata')) {
      logger.warn(`Run ${runId}: run_metadata column is unavailable, continuing without metadata persistence.`);
      return;
    }
    logger.warn(`Run ${runId}: failed to persist run metadata: ${message}`);
  }
}

function ensureGitRepository(runId: number, repoUrl: string, cachePath: string, branch: string): { success: boolean; error?: any } {
  try {
    const fs = require('fs');
    const lockPath = path.join(cachePath, '.git', 'index.lock');
    const targetBranch = branch || 'main';

    const clearStaleIndexLock = () => {
      if (fs.existsSync(lockPath)) {
        try {
          fs.unlinkSync(lockPath);
          logger.warn(`Run ${runId}: Removed stale git lock file at ${lockPath}`);
        } catch (lockErr: any) {
          logger.warn(`Run ${runId}: Failed to remove stale git lock at ${lockPath}: ${lockErr?.message || lockErr}`);
        }
      }
    };

    const syncExistingRepo = () => {
      execSync(`git fetch origin`, { cwd: cachePath, stdio: 'pipe' });
      execSync(`git reset --hard origin/${targetBranch}`, { cwd: cachePath, stdio: 'pipe' });
      execSync(`git pull origin ${targetBranch}`, { cwd: cachePath, stdio: 'pipe' });
    };

    if (!fs.existsSync(cachePath)) {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      logger.info(`Run ${runId}: Cloning repository ${repoUrl} to ${cachePath}`);
      execSync(`git clone ${branch ? `-b ${branch} ` : ''}"${repoUrl}" "${cachePath}"`, { stdio: 'pipe' });
    } else {
      logger.info(`Run ${runId}: Fetching latest from ${repoUrl}`);
      clearStaleIndexLock();
      try {
        syncExistingRepo();
      } catch (firstErr: any) {
        const errMessage = String(firstErr?.message || '');
        if (errMessage.includes('index.lock')) {
          logger.warn(`Run ${runId}: Git sync hit index.lock; retrying once after lock cleanup.`);
          clearStaleIndexLock();
          syncExistingRepo();
        } else {
          throw firstErr;
        }
      }
    }
    return { success: true };
  } catch (err: any) {
    logger.error(`Git synchronization failed for run ${runId}`, err);
    return { success: false, error: err };
  }
}

function recursiveSearch(dir: string, pattern: RegExp): string[] {
  const fs = require('fs');
  const path = require('path');
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const list = fs.readdirSync(dir);
  list.forEach((file: string) => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(recursiveSearch(fullPath, pattern));
    } else if (file.endsWith('.java')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (pattern.test(content)) {
        results.push(fullPath);
      }
    }
  });
  return results;
}

function stripCommentsFromJavaLine(
  line: string,
  inBlockComment: boolean
): { code: string; inBlockComment: boolean } {
  let cursor = line;
  let blockState = inBlockComment;
  let sanitized = '';

  while (cursor.length > 0) {
    if (blockState) {
      const blockEnd = cursor.indexOf('*/');
      if (blockEnd === -1) {
        return { code: sanitized, inBlockComment: true };
      }
      cursor = cursor.slice(blockEnd + 2);
      blockState = false;
      continue;
    }

    const lineCommentStart = cursor.indexOf('//');
    const blockCommentStart = cursor.indexOf('/*');

    if (lineCommentStart !== -1 && (blockCommentStart === -1 || lineCommentStart < blockCommentStart)) {
      sanitized += cursor.slice(0, lineCommentStart);
      return { code: sanitized, inBlockComment: false };
    }

    if (blockCommentStart !== -1) {
      sanitized += cursor.slice(0, blockCommentStart);
      cursor = cursor.slice(blockCommentStart + 2);
      blockState = true;
      continue;
    }

    sanitized += cursor;
    break;
  }

  return { code: sanitized, inBlockComment: blockState };
}

function extractOptionsVariableName(lines: string[], lineIndex: number): string | null {
  const parseCandidate = (candidate: string): string | null => {
    const normalized = candidate.trim();
    if (!normalized) return null;

    const varMatch = normalized.match(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*new\s+(?:Chrome|Edge)Options\s*\(/);
    if (varMatch?.[1]) return varMatch[1];

    const carryMatch = normalized.match(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*$/);
    if (carryMatch?.[1]) return carryMatch[1];

    return null;
  };

  let blockCommentState = false;
  const current = stripCommentsFromJavaLine(lines[lineIndex] || '', blockCommentState);
  blockCommentState = current.inBlockComment;
  const directMatch = parseCandidate(current.code);
  if (directMatch) return directMatch;

  for (let offset = 1; offset <= 3; offset++) {
    const previousIndex = lineIndex - offset;
    if (previousIndex < 0) break;
    const previous = stripCommentsFromJavaLine(lines[previousIndex] || '', blockCommentState);
    blockCommentState = previous.inBlockComment;
    const previousMatch = parseCandidate(previous.code);
    if (previousMatch) return previousMatch;
  }

  return null;
}

function hardenBrowserCertificateHandling(runId: number, stPath: string): { status: 'patched' | 'already' | 'skipped' | 'error'; message: string } {
  try {
    const fs = require('fs');
    const path = require('path');
    const sourceDir = path.join(stPath, 'src');

    if (!fs.existsSync(sourceDir)) {
      return { status: 'skipped', message: 'Source directory not found. Skipping certificate hardening.' };
    }

    const browserOptionsPattern = /new\s+(Chrome|Edge)Options\(\)/i;
    const filesToPatch = recursiveSearch(sourceDir, browserOptionsPattern);

    if (filesToPatch.length === 0) {
      return { status: 'skipped', message: 'No browser option initializations found in automation project.' };
    }

    let patchedCount = 0;
    filesToPatch.forEach(filePath => {
      const originalContent = fs.readFileSync(filePath, 'utf8');
      const lines = originalContent.split(/\r?\n/);
      const patchedLines: string[] = [];
      let fileModified = false;
      let inBlockComment = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        patchedLines.push(line);

        const analyzedLine = stripCommentsFromJavaLine(line, inBlockComment);
        inBlockComment = analyzedLine.inBlockComment;
        const codeLine = analyzedLine.code.trim();
        if (!codeLine) {
          continue;
        }

        if (browserOptionsPattern.test(codeLine)) {
          const nextLines = lines.slice(i + 1, i + 12).join('\n');
          if (nextLines.includes('setAcceptInsecureCerts(true)')) continue;

          const varName = extractOptionsVariableName(lines, i);
          if (!varName) {
            continue;
          }
          const indent = (line.match(/^(\s*)/) || [''])[0];

          patchedLines.push(`${indent}${varName}.setAcceptInsecureCerts(true);`);
          patchedLines.push(`${indent}${varName}.addArguments("--ignore-certificate-errors");`);
          patchedLines.push(`${indent}${varName}.addArguments("--allow-insecure-localhost");`);
          patchedLines.push(`${indent}${varName}.addArguments("--no-sandbox");`);
          patchedLines.push(`${indent}${varName}.addArguments("--disable-dev-shm-usage");`);
          fileModified = true;
        }
      }

      if (fileModified) {
        fs.writeFileSync(filePath, patchedLines.join(originalContent.includes('\r\n') ? '\r\n' : '\n'), 'utf8');
        patchedCount++;
      }
    });

    return {
      status: patchedCount > 0 ? 'patched' : 'already',
      message: patchedCount > 0
        ? `Enabled insecure certificate handling in ${patchedCount} file(s).`
        : 'Certificate hardening already present in workspace.'
    };
  } catch (err: any) {
    logger.error(`Run ${runId}: Failed to harden browser certificate handling`, err);
    return { status: 'error', message: `Failed to apply certificate hardening: ${err?.message || err}` };
  }
}

function hardenFrontDoorRequestHeaders(runId: number, stPath: string): { status: 'patched' | 'already' | 'skipped' | 'error'; message: string } {
  try {
    const fs = require('fs');
    const path = require('path');
    const targetFilePath = path.join(
      stPath,
      'src',
      'main',
      'java',
      'org',
      'example',
      'operations',
      'NoesisOperationImpl.java'
    );

    if (!fs.existsSync(targetFilePath)) {
      return { status: 'skipped', message: 'NoesisOperationImpl.java not found. Skipping Front Door header hardening.' };
    }

    const originalContent = fs.readFileSync(targetFilePath, 'utf8');
    const legacyMarker = 'X-NOESIS-FRONTDOOR-HARDENING';
    const browserFirstMarker = 'X-NOESIS-FRONTDOOR-BROWSER-FIRST';
    if (originalContent.includes(browserFirstMarker)) {
      return { status: 'already', message: 'Front Door browser-first strategy is already applied.' };
    }

    let patchedContent = originalContent;
    let modified = false;

    const jsFetchBlockPattern = /try\s*\{\s*String jsFetch =[\s\S]*?System\.out\.println\("In-page fetch\+open failed: " \+ fe\.getMessage\(\)\);\s*}\s*/m;
    if (jsFetchBlockPattern.test(patchedContent)) {
      const browserFirstBlock = [
        '                    try {',
        '                        // X-NOESIS-FRONTDOOR-BROWSER-FIRST',
        '                        String originalWindowHandle = driver.getWindowHandle();',
        '                        driver.switchTo().newWindow(org.openqa.selenium.WindowType.TAB);',
        '                        driver.get(href);',
        '                        System.out.println("Opened URL in browser tab: " + href);',
        '                        try { Thread.sleep(2200); } catch (InterruptedException ignored) {}',
        '                        try { driver.switchTo().window(originalWindowHandle); } catch (Exception ignored) {}',
        '                    } catch (Exception fe) {',
        '                        System.out.println("Browser-tab open failed: " + fe.getMessage());',
        '                    }',
        '',
        '                    if (!Boolean.parseBoolean(System.getProperty("noesis.allowJavaHttpFallback", "false"))) {',
        '                        long browserDownloadStart = System.currentTimeMillis();',
        '                        File browserFound = null;',
        '                        while ((System.currentTimeMillis() - browserDownloadStart) < 8000L) {',
        '                            File browserDir = new File(downloadDir);',
        '                            File[] browserMatches = browserDir.listFiles((d, name) -> name.endsWith(expectedFileNameSuffix) || name.toLowerCase().endsWith(expectedFileNameSuffix.toLowerCase()));',
        '                            if (browserMatches != null && browserMatches.length > 0) {',
        '                                Arrays.sort(browserMatches, Comparator.comparingLong(File::lastModified).reversed());',
        '                                for (File f : browserMatches) {',
        '                                    if (!f.getName().endsWith(".crdownload") && f.length() > 0) {',
        '                                        browserFound = f;',
        '                                        break;',
        '                                    }',
        '                                }',
        '                                if (browserFound != null) break;',
        '                            }',
        '                            try { Thread.sleep(500); } catch (InterruptedException ignored) {}',
        '                        }',
        '',
        '                        if (browserFound != null) {',
        '                            System.out.println("Browser-native download succeeded: " + browserFound.getAbsolutePath());',
        '                            return browserFound.getAbsolutePath();',
        '                        }',
        '',
        '                        System.out.println("Skipping Java HTTP fallback to avoid Front Door blocking; URL was opened in browser: " + href);',
        '                        return href;',
        '                    }',
        ''
      ].join('\n');

      patchedContent = patchedContent.replace(jsFetchBlockPattern, browserFirstBlock);
      modified = true;
    }

    const fetchNeedle = "fetch(href, {credentials: 'include'})";
    if (patchedContent.includes(fetchNeedle)) {
      patchedContent = patchedContent.replace(
        fetchNeedle,
        "fetch(href, {credentials: 'include', headers: {'Accept': 'application/xml,text/xml,application/xhtml+xml,text/html;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'X-Requested-With': 'XMLHttpRequest'}})"
      );
      modified = true;
    }

    const requestMethodNeedle = 'conn.setRequestMethod("GET");';
    if (patchedContent.includes(requestMethodNeedle)) {
      const headerBlock = [
        'conn.setRequestMethod("GET");',
        `                    // ${legacyMarker}`,
        '                    conn.setRequestProperty("Accept", "application/xml,text/xml,application/xhtml+xml,text/html;q=0.9,*/*;q=0.8");',
        '                    conn.setRequestProperty("Accept-Language", "en-US,en;q=0.9");',
        '                    conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36");',
        '                    conn.setRequestProperty("X-Requested-With", "XMLHttpRequest");',
        '                    try { conn.setRequestProperty("Referer", driver.getCurrentUrl()); } catch (Exception ignored) {}',
        '                    conn.setRequestProperty("Cache-Control", "no-cache");',
        '                    conn.setRequestProperty("Pragma", "no-cache");'
      ].join('\n');

      patchedContent = patchedContent.replace(requestMethodNeedle, headerBlock);
      modified = true;
    }

    if (!modified) {
      return { status: 'skipped', message: 'No known HTTP fetch/connection signatures found for Front Door hardening.' };
    }

    fs.writeFileSync(targetFilePath, patchedContent, 'utf8');
    return { status: 'patched', message: 'Applied Front Door browser-first URL opening strategy (real browser tab, session cookies).' };
  } catch (err: any) {
    logger.error(`Run ${runId}: Failed to harden Front Door request headers`, err);
    return { status: 'error', message: `Failed to apply Front Door hardening: ${err?.message || err}` };
  }
}

async function executeScripts(runId: number, testngXml: string, scripts: any[], userId: number, runName: string) {
  let stPath = config.stAutomation.path;
  const source = config.stAutomation.source;
  const fs = await import('fs');
  let tempXmlPath: string | null = null;

  try {
    // Log start immediately
    await insertExecutionLog(runId, 'INFO', `Execution triggered for ${scripts.length} script(s)`, {
      phase: 'start', runName, scriptCount: scripts.length, capturedAt: new Date().toISOString()
    });

    if (io) {
      io.to(`run-${runId}`).emit('run-log', {
        runId, level: 'INFO', message: `Execution triggered for ${scripts.length} script(s)`, timestamp: new Date()
      });
    }

    if (source === 'git') {
      if (io) {
        io.to(`run-${runId}`).emit('run-log', {
          runId, level: 'INFO', message: `▶ Syncing repository from Git... (${config.stAutomation.gitRepoUrl})`, timestamp: new Date()
        });
      }
      const syncRes = ensureGitRepository(runId, config.stAutomation.gitRepoUrl, config.stAutomation.gitCachePath, config.stAutomation.gitBranch);
      if (!syncRes.success) {
        throw new Error(`Git Sync Failed: ${syncRes.error?.message || 'Unknown error'}`);
      }
      stPath = config.stAutomation.gitCachePath;
      if (io) {
        io.to(`run-${runId}`).emit('run-log', {
          runId, level: 'INFO', message: `✅ Repository synced to cached workspace.`, timestamp: new Date()
        });
      }
    }

    const certificateHardening = hardenBrowserCertificateHandling(runId, stPath);
    const certHardeningLevel =
      certificateHardening.status === 'error'
        ? 'ERROR'
        : certificateHardening.status === 'skipped'
          ? 'WARN'
          : 'INFO';

    await insertExecutionLog(runId, certHardeningLevel, certificateHardening.message, {
      phase: 'system',
      runName,
      capturedAt: new Date().toISOString(),
      keyword: 'certificate_hardening',
    }).catch(() => {});

    if (io) {
      io.to(`run-${runId}`).emit('run-log', {
        runId,
        level: certHardeningLevel,
        message: certificateHardening.message,
        timestamp: new Date(),
      });
    }

    const frontDoorHardening = hardenFrontDoorRequestHeaders(runId, stPath);
    const frontDoorHardeningLevel =
      frontDoorHardening.status === 'error'
        ? 'ERROR'
        : frontDoorHardening.status === 'skipped'
          ? 'WARN'
          : 'INFO';

    await insertExecutionLog(runId, frontDoorHardeningLevel, frontDoorHardening.message, {
      phase: 'system',
      runName,
      capturedAt: new Date().toISOString(),
      keyword: 'front_door_hardening',
    }).catch(() => {});

    if (io) {
      io.to(`run-${runId}`).emit('run-log', {
        runId,
        level: frontDoorHardeningLevel,
        message: frontDoorHardening.message,
        timestamp: new Date(),
      });
    }

    const suiteFileName = `Testing-Config-Local-run-${runId}.xml`;
    tempXmlPath = path.join(stPath, suiteFileName);

    // Write temporary TestNG XML
    fs.writeFileSync(tempXmlPath, testngXml, 'utf8');

    // Determine Maven command
    const mvnCmd = process.platform === 'win32' ? 'mvn.cmd' : 'mvn';
    const surefireReportsDirectory = path.join('target', 'surefire-reports', `run-${runId}`);
    const mavenArgs = [
      'test',
      `-Dsurefire.suiteXmlFiles=${suiteFileName}`,
      `-DsuiteXmlFile=${suiteFileName}`,
      `-Dsurefire.reportsDirectory=${surefireReportsDirectory}`,
    ];

    const commandPreview = [mvnCmd, ...mavenArgs].join(' ');
    const reportsDirectory = path.join(stPath, surefireReportsDirectory);
    let appUrl = resolveExecutionAppUrlFromTestClasses(
      runId,
      stPath,
      scripts.map((script: any) => script.class_name).filter(Boolean)
    );

    if (!appUrl) {
      appUrl = resolveExecutionAppUrlFromWorkspaceResources(runId, stPath);
    }

    const runMetadata: RunMetadata = {
      executionSource: source === 'git' ? 'git' : 'local',
      gitRepoUrl: source === 'git' ? config.stAutomation.gitRepoUrl || null : null,
      gitBranch: source === 'git' ? config.stAutomation.gitBranch || null : null,
      appUrl: appUrl || null,
      workspacePath: stPath,
      suiteFilePath: tempXmlPath,
      suiteFileName,
      mavenCommand: commandPreview,
      reportsDirectory,
      certificateHardeningStatus: certificateHardening.status,
      certificateHardeningMessage: certificateHardening.message,
      startedAt: new Date().toISOString(),
    };

    await persistRunMetadata(runId, runMetadata);

    if (io) {
      io.to(`run-${runId}`).emit('run-log', {
        runId,
        level: 'INFO',
        message: `▶ Running command: ${commandPreview}`,
        timestamp: new Date(),
      });
      io.to(`run-${runId}`).emit('run-log', {
        runId,
        level: 'INFO',
        message: `▶ Reports directory: ${reportsDirectory}`,
        timestamp: new Date(),
      });
    }

    const child = spawn(mvnCmd, mavenArgs, {
      cwd: stPath,
      shell: process.platform === 'win32',
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

      // Capture report artifacts
      let artifacts = [];
      try {
        artifacts = await captureReportArtifacts(runId, scripts, stPath);
      } catch (e) {
        logger.error(`Failed to capture report artifacts for run ${runId}`, e);
      }

      const completedMetadata: RunMetadata = {
        ...runMetadata,
        completedAt: new Date().toISOString(),
        finalStatus,
        exitCode: code,
        resultSummary: { passed, failed, errors, skipped },
        artifactCount: artifacts.length,
      };

      await persistRunMetadata(runId, completedMetadata);

      if (io) {
        if (artifacts.length > 0) {
          io.to(`run-${runId}`).emit('run-artifacts-ready', artifacts);
        }
        io.to(`run-${runId}`).emit('run-completed', {
          runId, status: finalStatus, passed, failed, errors, skipped, artifacts, runMetadata: completedMetadata
        });
        io.emit('global-run-status', {
          runId, runName, status: finalStatus, passed, failed, errors, skipped, artifacts
        });
      }

      // Clean up temp file
      try { if (tempXmlPath) fs.unlinkSync(tempXmlPath); } catch {}

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
    const failureMessage = error?.message || 'Execution failed before process startup.';

    await insertExecutionLog(runId, 'ERROR', failureMessage, {
      phase: 'status',
      runName,
      capturedAt: new Date().toISOString(),
      keyword: 'execution_start_failure',
    }).catch(() => {});

    await execute(
      "UPDATE execution_runs SET status = 'error', completed_at = NOW() WHERE id = $1",
      [runId]
    );

    if (io) {
      io.to(`run-${runId}`).emit('run-log', {
        runId,
        level: 'ERROR',
        message: `✗ ${failureMessage}`,
        timestamp: new Date(),
      });
      io.to(`run-${runId}`).emit('run-error', { runId, error: failureMessage });
      io.emit('global-run-status', { runId, runName, status: 'error', error: failureMessage });
    }

    if (tempXmlPath) { try { (await import('fs')).unlinkSync(tempXmlPath); } catch {} }
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

async function captureReportArtifacts(runId: number, scripts: any[], executionWorkspacePath: string) {
  const fs = await import('fs');
  const path = await import('path');

  const surefireBasePath = path.join(executionWorkspacePath, 'target', 'surefire-reports');
  const runSurefirePath = path.join(surefireBasePath, `run-${runId}`);
  const surefirePath = fs.existsSync(runSurefirePath) ? runSurefirePath : surefireBasePath;
  const reportsOutputBase = (config.stAutomation as any).reportsPath || path.join(executionWorkspacePath, 'noesis-reports');
  const runReportDir = path.join(reportsOutputBase, `run-${runId}`);

  if (!fs.existsSync(surefirePath)) {
    logger.warn(`Surefire reports directory not found at ${surefirePath}`);
    return [];
  }

  if (!fs.existsSync(runReportDir)) {
    fs.mkdirSync(runReportDir, { recursive: true });
  }

  const files = fs.readdirSync(surefirePath);
  const reportFiles = files.filter(file => {
    const lowerFile = file.toLowerCase();
    return lowerFile.endsWith('.html') || lowerFile.endsWith('.pdf');
  });

  if (reportFiles.length === 0) {
    return [];
  }

  const reportCandidates = reportFiles.map((file) => {
    const lowerFile = file.toLowerCase();
    let scriptId: number | null = null;

    for (const script of scripts) {
      const scriptName = String(script?.name || '').trim().toLowerCase();
      if (scriptName && lowerFile.includes(scriptName)) {
        scriptId = script.id;
        break;
      }
    }

    return { file, scriptId };
  });

  const hasScriptMatchedArtifacts = reportCandidates.some(candidate => candidate.scriptId !== null);
  if (!hasScriptMatchedArtifacts) {
    logger.warn(`Run ${runId}: no report files matched script names. Persisting all HTML/PDF artifacts with null script mapping.`);
  }

  const capturedArtifacts: any[] = [];

  for (const candidate of reportCandidates) {
    if (hasScriptMatchedArtifacts && candidate.scriptId === null) {
      continue;
    }

    const file = candidate.file;
    const srcPath = path.join(surefirePath, file);
    const destPath = path.join(runReportDir, file);
    fs.copyFileSync(srcPath, destPath);

    const stats = fs.statSync(destPath);
    const ext = path.extname(file).toLowerCase();
    const artifactType = ext === '.pdf' ? 'pdf' : ext === '.html' ? 'html' : 'other';
    const mimeType = ext === '.pdf' ? 'application/pdf' : 'text/html';
    const scriptId = candidate.scriptId;

    const result = await execute(
      `INSERT INTO execution_artifacts (run_id, script_id, artifact_type, file_name, stored_path, file_size_bytes, mime_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [runId, scriptId, artifactType, file, destPath, stats.size, mimeType]
    );

    capturedArtifacts.push({
      id: result.rows[0].id,
      runId,
      scriptId,
      artifactType,
      fileName: file,
      fileSizeBytes: stats.size,
      mimeType,
      createdAt: new Date()
    });
  }

  return capturedArtifacts;
}

// Expose executeScripts for the scheduler service to call
export function triggerScheduledExecution(runId: number, testngXml: string, scripts: any[], userId: number, runName: string) {
  executeScripts(runId, testngXml, scripts, userId, runName);
}

// ---- Artifact Routes ----

// GET /api/execution/runs/:runId/artifacts - Get artifacts for a run
router.get('/runs/:runId/artifacts', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const runId = parseInt(req.params.runId as string);
    const rows = await query<any>(
      'SELECT * FROM execution_artifacts WHERE run_id = $1 ORDER BY created_at ASC',
      [runId]
    );

    res.json(rows.map(r => ({
      id: r.id,
      runId: r.run_id,
      scriptId: r.script_id,
      artifactType: r.artifact_type,
      fileName: r.file_name,
      fileSizeBytes: r.file_size_bytes,
      mimeType: r.mime_type,
      createdAt: r.created_at,
    })));
  } catch (error) {
    logger.error('List artifacts error:', error);
    res.status(500).json({ error: 'Failed to fetch artifacts.' });
  }
});

// GET /api/execution/artifacts/:id/download - Download an artifact
router.get('/artifacts/:id/download', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const artifactId = parseInt(req.params.id as string);
    const rows = await query<any>(
      'SELECT * FROM execution_artifacts WHERE id = $1',
      [artifactId]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Artifact not found.' });
      return;
    }

    const artifact = rows[0];
    const fs = await import('fs');
    if (!fs.existsSync(artifact.stored_path)) {
      res.status(404).json({ error: 'Artifact file not found on disk.' });
      return;
    }

    res.download(artifact.stored_path, artifact.file_name);
  } catch (error) {
    logger.error('Download artifact error:', error);
    res.status(500).json({ error: 'Failed to download artifact.' });
  }
});

// ---- Schedule CRUD Routes ----

// POST /api/execution/schedule - Create a new scheduled run
router.post('/schedule', authorize('admin', 'tester'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name, scriptIds, suiteId, cronExpression, environment = 'local', description, isOneTime = false } = req.body;

    if (!name || !name.trim()) {
      res.status(400).json({ error: 'Schedule name is required.' });
      return;
    }

    if (!cronExpression || !cron.validate(cronExpression)) {
      res.status(400).json({ error: 'Invalid cron expression.' });
      return;
    }

    if ((!scriptIds || !Array.isArray(scriptIds) || scriptIds.length === 0) && !suiteId) {
      res.status(400).json({ error: 'Either script IDs or a suite ID is required.' });
      return;
    }

    if (req.userRole === 'tester') {
      let idsToCheck = scriptIds || [];
      if (suiteId) {
        const suiteScripts = await query<{ script_id: number }>(
          'SELECT script_id FROM suite_scripts WHERE suite_id = $1',
          [suiteId]
        );
        idsToCheck = [...new Set([...idsToCheck, ...suiteScripts.map(s => s.script_id)])];
      }

      const hasAccess = await checkScriptAssignments(req.userId!, req.userRole!, idsToCheck);
      if (!hasAccess) {
        res.status(403).json({ error: 'Access denied: One or more scripts in this selection/suite are not assigned to you.' });
        return;
      }
    }

    const nextRunAt = computeNextRun(cronExpression);

    const result = await execute(
      `INSERT INTO scheduled_runs (name, suite_id, script_ids, cron_expression, environment, description, is_one_time, next_run_at, created_by)\n       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        name.trim(),
        suiteId || null,
        scriptIds ? JSON.stringify(scriptIds) : null,
        cronExpression,
        environment,
        description || null,
        isOneTime,
        nextRunAt,
        req.userId,
      ]
    );

    const created = result.rows[0];

    // Register the cron task immediately
    await refreshSchedule(created.id);

    appLogService.logSystemEvent({
      action: 'SCHEDULE_CREATE',
      module: 'scheduler',
      severity: 'INFO',
      status: 'SUCCESS',
      message: `Schedule "${name}" created with cron: ${cronExpression}`,
      userId: req.userId,
      username: req.username || '',
      metadata: { scheduleId: created.id, cronExpression },
    });

    res.status(201).json({
      id: created.id,
      name: created.name,
      suiteId: created.suite_id,
      scriptIds: created.script_ids,
      cronExpression: created.cron_expression,
      description: created.description,
      isOneTime: created.is_one_time,
      isActive: created.is_active,
      environment: created.environment,
      nextRunAt: created.next_run_at,
      createdAt: created.created_at,
    });
  } catch (error) {
    logger.error('Create schedule error:', error);
    res.status(500).json({ error: 'Failed to create schedule.' });
  }
});

// GET /api/execution/schedules - List all scheduled runs
router.get('/schedules', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rows = await query<any>(
      `SELECT sr.*, u.full_name as created_by_name
       FROM scheduled_runs sr
       LEFT JOIN users u ON sr.created_by = u.id
       ORDER BY sr.created_at DESC`
    );

    res.json(rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      suiteId: r.suite_id,
      scriptIds: r.script_ids,
      cronExpression: r.cron_expression,
      description: r.description,
      isOneTime: r.is_one_time,
      isActive: r.is_active,
      environment: r.environment,
      lastRunAt: r.last_run_at,
      nextRunAt: r.next_run_at,
      createdBy: r.created_by_name,
      createdAt: r.created_at,
    })));
  } catch (error) {
    logger.error('List schedules error:', error);
    res.status(500).json({ error: 'Failed to fetch schedules.' });
  }
});

// PUT /api/execution/schedules/:id - Update a schedule
router.put('/schedules/:id', authorize('admin', 'tester'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { name, cronExpression, isActive, environment, description, isOneTime } = req.body;

    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (name !== undefined) {
      sets.push(`name = $${idx++}`);
      params.push(name);
    }
    if (cronExpression !== undefined) {
      if (!cron.validate(cronExpression)) {
        res.status(400).json({ error: 'Invalid cron expression.' });
        return;
      }
      sets.push(`cron_expression = $${idx++}`);
      params.push(cronExpression);
      const nextRun = computeNextRun(cronExpression);
      sets.push(`next_run_at = $${idx++}`);
      params.push(nextRun);
    }
    if (isActive !== undefined) {
      sets.push(`is_active = $${idx++}`);
      params.push(isActive);
    }
    if (environment !== undefined) {
      sets.push(`environment = $${idx++}`);
      params.push(environment);
    }
    if (description !== undefined) {
      sets.push(`description = ${idx++}`);
      params.push(description);
    }
    if (isOneTime !== undefined) {
      sets.push(`is_one_time = ${idx++}`);
      params.push(isOneTime);
    }

    if (sets.length === 0) {
      res.status(400).json({ error: 'No fields to update.' });
      return;
    }

    params.push(parseInt(id as string));
    await execute(
      `UPDATE scheduled_runs SET ${sets.join(', ')} WHERE id = $${idx}`,
      params
    );

    // Refresh the cron task
    await refreshSchedule(parseInt(id as string));

    res.json({ message: 'Schedule updated.' });
  } catch (error) {
    logger.error('Update schedule error:', error);
    res.status(500).json({ error: 'Failed to update schedule.' });
  }
});

// DELETE /api/execution/schedules/:id - Delete a schedule
router.delete('/schedules/:id', authorize('admin', 'tester'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id as string);

    // Stop the cron task
    unregisterTask(id);

    await execute('DELETE FROM scheduled_runs WHERE id = $1', [id]);

    appLogService.logSystemEvent({
      action: 'SCHEDULE_DELETE',
      module: 'scheduler',
      severity: 'INFO',
      status: 'SUCCESS',
      message: `Schedule ID ${id} deleted.`,
      userId: req.userId,
      username: req.username || '',
    });

    res.json({ message: 'Schedule deleted.' });
  } catch (error) {
    logger.error('Delete schedule error:', error);
    res.status(500).json({ error: 'Failed to delete schedule.' });
  }
});

export default router;
