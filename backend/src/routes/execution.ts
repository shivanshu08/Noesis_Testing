import { Router, Response } from 'express';
import { query, execute, getConnection } from '../database/connection';
import { authenticate, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import { config } from '../config';
import { RowDataPacket } from 'mysql2';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { Server as SocketIOServer } from 'socket.io';

const router = Router();
router.use(authenticate);

// Store active processes
const activeProcesses = new Map<number, ChildProcess>();

let io: SocketIOServer | null = null;
export function setSocketIO(socketIO: SocketIOServer) {
  io = socketIO;
}

interface RunRow extends RowDataPacket {
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
}

interface ResultRow extends RowDataPacket {
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

// POST /api/execution/run - Execute scripts
router.post('/run', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { scriptIds, suiteName, environment = 'local' } = req.body;

    if (!scriptIds || !Array.isArray(scriptIds) || scriptIds.length === 0) {
      res.status(400).json({ error: 'At least one script ID is required.' });
      return;
    }

    // Fetch script details
    const placeholders = scriptIds.map(() => '?').join(',');
    const scripts = await query<RowDataPacket[]>(
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
    const conn = await getConnection();
    try {
      await conn.beginTransaction();

      const [runResult] = await conn.execute(
        'INSERT INTO execution_runs (run_name, run_type, status, total_scripts, environment, config_xml, triggered_by, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())',
        [runName, runType, 'running', scripts.length, environment, testngXml, req.userId]
      );
      const runId = (runResult as any).insertId;

      // Create result records for each script
      for (const script of scripts) {
        await conn.execute(
          'INSERT INTO execution_results (run_id, script_id, status) VALUES (?, ?, ?)',
          [runId, script.id, 'queued']
        );
      }

      await conn.commit();

      // Start execution in background
      executeScripts(runId, testngXml, scripts, req.userId!);

      res.status(201).json({
        runId,
        message: 'Execution started.',
        totalScripts: scripts.length,
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (error) {
    logger.error('Start execution error:', error);
    res.status(500).json({ error: 'Failed to start execution.' });
  }
});

// POST /api/execution/stop/:runId - Stop a running execution
router.post('/stop/:runId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const runId = parseInt(req.params.runId);
    const process = activeProcesses.get(runId);

    if (process) {
      process.kill('SIGTERM');
      activeProcesses.delete(runId);
    }

    await execute(
      'UPDATE execution_runs SET status = ?, completed_at = NOW() WHERE id = ? AND status = ?',
      ['stopped', runId, 'running']
    );

    await execute(
      'UPDATE execution_results SET status = ? WHERE run_id = ? AND status IN (?, ?)',
      ['skipped', runId, 'queued', 'running']
    );

    if (io) {
      io.to(`run-${runId}`).emit('run-stopped', { runId });
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

    if (status) {
      sql += ' AND er.status = ?';
      params.push(status);
    }

    sql += ' ORDER BY er.created_at DESC LIMIT ? OFFSET ?';
    params.push(Number(limit), Number(offset));

    const runs = await query<RunRow[]>(sql, params);
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
    const runs = await query<RunRow[]>(`
      SELECT er.*, u.full_name as triggered_by_name
      FROM execution_runs er
      LEFT JOIN users u ON er.triggered_by = u.id
      WHERE er.id = ?
    `, [req.params.id]);

    if (runs.length === 0) {
      res.status(404).json({ error: 'Run not found.' });
      return;
    }

    const results = await query<ResultRow[]>(`
      SELECT eres.*, s.name as script_name, s.class_name
      FROM execution_results eres
      JOIN scripts s ON eres.script_id = s.id
      WHERE eres.run_id = ?
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
    const [totalScripts] = await query<RowDataPacket[]>('SELECT COUNT(*) as count FROM scripts WHERE is_active = TRUE');
    const [totalRuns] = await query<RowDataPacket[]>('SELECT COUNT(*) as count FROM execution_runs');
    const [recentRuns] = await query<RowDataPacket[]>(
      'SELECT COUNT(*) as count FROM execution_runs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)'
    );
    const [passRate] = await query<RowDataPacket[]>(`
      SELECT
        ROUND(AVG(CASE WHEN status = 'passed' THEN 100 ELSE 0 END), 1) as rate
      FROM execution_runs
      WHERE status IN ('passed', 'failed') AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
    `);
    const runningRuns = await query<RowDataPacket[]>(
      "SELECT COUNT(*) as count FROM execution_runs WHERE status = 'running'"
    );
    const recentHistory = await query<RowDataPacket[]>(`
      SELECT DATE(created_at) as date, status, COUNT(*) as count
      FROM execution_runs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY DATE(created_at), status
      ORDER BY date
    `);

    const categoryStats = await query<RowDataPacket[]>(`
      SELECT sc.name, sc.color, COUNT(s.id) as count
      FROM script_categories sc
      LEFT JOIN scripts s ON sc.id = s.category_id AND s.is_active = TRUE
      GROUP BY sc.id
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

// GET /api/execution/logs/:runId - Get execution logs
router.get('/logs/:runId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const logs = await query<RowDataPacket[]>(
      'SELECT * FROM execution_logs WHERE run_id = ? ORDER BY timestamp',
      [req.params.runId]
    );
    res.json(logs);
  } catch (error) {
    logger.error('Get logs error:', error);
    res.status(500).json({ error: 'Failed to fetch logs.' });
  }
});

// ---- Helper Functions ----

function buildTestNGXml(suiteName: string, scripts: RowDataPacket[]): string {
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

async function executeScripts(runId: number, testngXml: string, scripts: RowDataPacket[], userId: number) {
  const stPath = config.stAutomation.path;
  const fs = await import('fs');
  const tempXmlPath = path.join(stPath, `temp-run-${runId}.xml`);

  try {
    // Write temporary TestNG XML
    fs.writeFileSync(tempXmlPath, testngXml, 'utf8');

    // Log start
    await execute(
      'INSERT INTO execution_logs (run_id, log_level, message) VALUES (?, ?, ?)',
      [runId, 'INFO', `Execution started for ${scripts.length} script(s)`]
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
        const logLevel = line.includes('ERROR') ? 'ERROR' : line.includes('WARN') ? 'WARN' : 'INFO';

        await execute(
          'INSERT INTO execution_logs (run_id, log_level, message) VALUES (?, ?, ?)',
          [runId, logLevel, line.substring(0, 2000)]
        ).catch(() => {});

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

      await execute(
        'INSERT INTO execution_logs (run_id, log_level, message) VALUES (?, ?, ?)',
        [runId, 'ERROR', text.substring(0, 2000)]
      ).catch(() => {});

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
        'UPDATE execution_runs SET status = ?, passed_count = ?, failed_count = ?, error_count = ?, skipped_count = ?, completed_at = NOW(), duration_ms = TIMESTAMPDIFF(MICROSECOND, started_at, NOW()) / 1000 WHERE id = ?',
        [finalStatus, passed, failed, errors, skipped, runId]
      );

      // Update individual results based on output
      await execute(
        `UPDATE execution_results SET status = ?, completed_at = NOW() WHERE run_id = ? AND status IN ('queued', 'running')`,
        [finalStatus, runId]
      );

      // Save full output
      await execute(
        `UPDATE execution_results SET log_output = ? WHERE run_id = ?`,
        [output.substring(0, 65000), runId]
      );

      if (io) {
        io.to(`run-${runId}`).emit('run-completed', {
          runId, status: finalStatus, passed, failed, errors, skipped,
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
        "UPDATE execution_runs SET status = 'error', completed_at = NOW() WHERE id = ?",
        [runId]
      );

      if (io) {
        io.to(`run-${runId}`).emit('run-error', { runId, error: err.message });
      }
    });

  } catch (error: any) {
    logger.error(`Execute scripts error for run ${runId}:`, error);
    await execute(
      "UPDATE execution_runs SET status = 'error', completed_at = NOW() WHERE id = ?",
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
