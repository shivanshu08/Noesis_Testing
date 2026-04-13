import * as cron from 'node-cron';
import { query, execute, getConnection } from '../database/connection';
import { logger } from '../utils/logger';
import { appLogService } from './appLogService';

interface ScheduledRunRow {
  id: number;
  name: string;
  suite_id: number | null;
  script_ids: number[] | null;
  cron_expression: string;
  environment: string;
  is_one_time: boolean;
  is_active: boolean;
  created_by: number | null;
}

// Store active cron tasks keyed by schedule ID
const activeTasks = new Map<number, cron.ScheduledTask>();

/**
 * Compute the next run time for a cron expression (approximate).
 * Uses a simple forward-scan approach: iterate from `from` in 1-minute steps
 * and find the first minute that matches the cron.
 */
export function computeNextRun(cronExpr: string, from: Date = new Date()): Date | null {
  if (!cron.validate(cronExpr)) return null;

  // Parse the cron expression parts
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return null;

  const [minPart, hourPart, domPart, monPart, dowPart] = parts;

  const matchesField = (value: number, field: string, max: number): boolean => {
    if (field === '*') return true;
    // Handle */n
    if (field.startsWith('*/')) {
      const step = parseInt(field.substring(2), 10);
      return value % step === 0;
    }
    // Handle comma-separated values
    const values = field.split(',').map(v => parseInt(v, 10));
    return values.includes(value);
  };

  // Scan forward up to 7 days (10080 minutes)
  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let i = 0; i < 10080; i++) {
    const min = candidate.getMinutes();
    const hour = candidate.getHours();
    const dom = candidate.getDate();
    const mon = candidate.getMonth() + 1;
    const dow = candidate.getDay();

    if (
      matchesField(min, minPart, 59) &&
      matchesField(hour, hourPart, 23) &&
      matchesField(dom, domPart, 31) &&
      matchesField(mon, monPart, 12) &&
      matchesField(dow, dowPart, 6)
    ) {
      return candidate;
    }

    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}

/**
 * Human-readable description of a cron expression
 */
export function describeCron(cronExpr: string): string {
  const presets: Record<string, string> = {
    '0 9 * * *': 'Daily at 9:00 AM',
    '0 9 * * 1-5': 'Weekdays at 9:00 AM',
    '0 9 * * 1': 'Every Monday at 9:00 AM',
    '0 18 * * 5': 'Every Friday at 6:00 PM',
    '0 0 * * 0': 'Every Sunday at midnight',
    '0 6 * * *': 'Daily at 6:00 AM',
    '0 12 * * *': 'Daily at 12:00 PM',
    '0 18 * * *': 'Daily at 6:00 PM',
    '0 21 * * *': 'Daily at 9:00 PM',
  };
  return presets[cronExpr.trim()] || cronExpr;
}

/**
 * Execute a scheduled run — triggers the same execution flow as manual runs
 */
async function executeScheduledRun(schedule: ScheduledRunRow): Promise<void> {
  logger.info(`Scheduler: Triggering scheduled run "${schedule.name}" (ID: ${schedule.id})`);

  try {
    let scriptIds: number[] = [];

    if (schedule.script_ids && Array.isArray(schedule.script_ids) && schedule.script_ids.length > 0) {
      scriptIds = schedule.script_ids;
    } else if (schedule.suite_id) {
      // Fetch scripts from suite
      const suiteScripts = await query<{ script_id: number }>(
        'SELECT script_id FROM suite_scripts WHERE suite_id = $1 ORDER BY execution_order',
        [schedule.suite_id]
      );
      scriptIds = suiteScripts.map(s => s.script_id);
    }

    if (scriptIds.length === 0) {
      logger.warn(`Scheduler: No scripts found for schedule "${schedule.name}"`);
      return;
    }

    // Fetch script details
    const placeholders = scriptIds.map((_, i) => `$${i + 1}`).join(',');
    const scripts = await query<any>(
      `SELECT id, name, class_name, method_name FROM scripts WHERE id IN (${placeholders}) AND is_active = TRUE`,
      scriptIds
    );

    if (scripts.length === 0) {
      logger.warn(`Scheduler: No active scripts found for schedule "${schedule.name}"`);
      return;
    }

    const runName = `[Scheduled] ${schedule.name} — ${new Date().toISOString().replace('T', ' ').substring(0, 19)}`;
    const runType = scripts.length === 1 ? 'single' : 'custom';

    // Build TestNG XML
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<!DOCTYPE suite SYSTEM "https://testng.org/testng-1.0.dtd">\n`;
    xml += `<suite name="${escapeXml(runName)}" parallel="false">\n`;
    xml += `  <listeners>\n`;
    xml += `    <listener class-name="org.example.utility.CustomHtmlReporter"/>\n`;
    xml += `    <listener class-name="org.example.utility.PreExecutionReviewListener"/>\n`;
    xml += `    <listener class-name="org.example.utility.ExecutionOrderListener"/>\n`;
    xml += `  </listeners>\n`;
    xml += `  <test name="Scheduled Test">\n`;
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

    const client = await getConnection();
    try {
      await client.query('BEGIN');

      const runResult = await client.query(
        `INSERT INTO execution_runs (run_name, run_type, status, total_scripts, environment, config_xml, triggered_by, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING id`,
        [runName, runType, 'running', scripts.length, schedule.environment, xml, schedule.created_by]
      );
      const runId = runResult.rows[0].id;

      for (const script of scripts) {
        await client.query(
          'INSERT INTO execution_results (run_id, script_id, status) VALUES ($1, $2, $3)',
          [runId, script.id, 'queued']
        );
      }

      await client.query('COMMIT');

      // Update last_run_at and next_run_at
      const nextRun = computeNextRun(schedule.cron_expression);
      if (schedule.is_one_time) {
        await execute(
          'UPDATE scheduled_runs SET last_run_at = NOW(), next_run_at = NULL, is_active = FALSE WHERE id = $1',
          [schedule.id]
        );
        schedule.is_active = false;
        refreshSchedule(schedule.id);
      } else {
        await execute(
          'UPDATE scheduled_runs SET last_run_at = NOW(), next_run_at = $1 WHERE id = $2',
          [nextRun, schedule.id]
        );
      }

      // Trigger the actual execution (import the executeScripts function dynamically)
      // We emit a 'trigger-run' event that the execution module handles
      const { triggerScheduledExecution } = await import('../routes/execution');
      triggerScheduledExecution(runId, xml, scripts, schedule.created_by || 1, runName);

      appLogService.logSystemEvent({
        action: 'SCHEDULED_RUN_TRIGGERED',
        module: 'scheduler',
        severity: 'INFO',
        status: 'SUCCESS',
        message: `Scheduled run "${schedule.name}" triggered. Run ID: ${runId}, Scripts: ${scripts.length}`,
        metadata: {
          scheduleId: schedule.id,
          runId,
          scriptCount: scripts.length,
        },
      });

      logger.info(`Scheduler: Run #${runId} started for schedule "${schedule.name}"`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error(`Scheduler: Failed to execute schedule "${schedule.name}":`, error);
    appLogService.logSystemEvent({
      action: 'SCHEDULED_RUN_FAILED',
      module: 'scheduler',
      severity: 'ERROR',
      status: 'FAILED',
      message: `Failed to trigger scheduled run "${schedule.name}": ${(error as Error).message}`,
      metadata: { scheduleId: schedule.id },
    });
  }
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Register a cron task for a schedule
 */
function registerTask(schedule: ScheduledRunRow): void {
  // Remove existing task if any
  const existing = activeTasks.get(schedule.id);
  if (existing) {
    existing.stop();
    activeTasks.delete(schedule.id);
  }

  if (!schedule.is_active) return;
  if (!cron.validate(schedule.cron_expression)) {
    logger.warn(`Scheduler: Invalid cron expression for schedule ${schedule.id}: "${schedule.cron_expression}"`);
    return;
  }

  const task = cron.schedule(schedule.cron_expression, () => {
    executeScheduledRun(schedule);
  });

  activeTasks.set(schedule.id, task);
  logger.info(`Scheduler: Registered task for "${schedule.name}" (${schedule.cron_expression})`);
}

/**
 * Unregister a cron task
 */
export function unregisterTask(scheduleId: number): void {
  const task = activeTasks.get(scheduleId);
  if (task) {
    task.stop();
    activeTasks.delete(scheduleId);
    logger.info(`Scheduler: Unregistered task for schedule ${scheduleId}`);
  }
}

/**
 * Refresh a single schedule's task (after create/update)
 */
export async function refreshSchedule(scheduleId: number): Promise<void> {
  const rows = await query<ScheduledRunRow>(
    'SELECT id, name, suite_id, script_ids, cron_expression, is_one_time, is_active, environment, created_by FROM scheduled_runs WHERE id = $1',
    [scheduleId]
  );
  if (rows.length > 0) {
    registerTask(rows[0]);
  } else {
    unregisterTask(scheduleId);
  }
}

/**
 * Initialize the scheduler — load all active schedules from DB and register them
 */
export async function initScheduler(): Promise<void> {
  try {
    const schedules = await query<ScheduledRunRow>(
      'SELECT id, name, suite_id, script_ids, cron_expression, is_one_time, is_active, environment, created_by FROM scheduled_runs WHERE is_active = TRUE'
    );

    for (const schedule of schedules) {
      registerTask(schedule);
    }

    logger.info(`Scheduler: Initialized with ${schedules.length} active schedule(s)`);
    appLogService.logSystemEvent({
      action: 'SCHEDULER_INIT',
      module: 'scheduler',
      severity: 'INFO',
      status: 'SUCCESS',
      message: `Scheduler initialized with ${schedules.length} active schedule(s).`,
    });
  } catch (error) {
    logger.error('Scheduler: Failed to initialize:', error);
  }
}

/**
 * Shutdown the scheduler — stop all active tasks
 */
export function shutdownScheduler(): void {
  for (const [id, task] of activeTasks) {
    task.stop();
  }
  activeTasks.clear();
  logger.info('Scheduler: All tasks stopped');
}
