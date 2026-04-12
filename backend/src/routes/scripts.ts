import { Router, Response } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { query, execute } from '../database/connection';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import { config } from '../config';
import { appLogService } from '../services/appLogService';

const router = Router();
router.use(authenticate);
const execFileAsync = promisify(execFile);

interface ScriptRow {
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
  tags: any | null;
  created_at: Date;
}

interface CategoryRow {
  id: number;
  name: string;
  description: string | null;
  icon: string;
  color: string;
  sort_order: number;
  script_count: number;
}

interface JavaScriptMetadata {
  className: string;
  packageName: string | null;
}

interface ScriptConflictRow {
  id: number;
  name: string;
  class_name: string;
  file_path: string;
  is_active: boolean;
}

interface ScriptPathRow {
  id: number;
  name: string;
  file_path: string;
}

interface ScriptSyncRow {
  id: number;
  name: string;
  class_name: string;
  category_id: number;
  file_path: string;
  is_active: boolean;
}

interface SyncSourceRoot {
  rootPath: string;
  pathPrefix: string;
}

interface CategoryLookupRow {
  id: number;
  name: string;
  sort_order: number;
}

interface CategoryLookup {
  defaultId: number;
  byName: Map<string, number>;
}

// Memory storage for script imports
const upload = multer({ storage: multer.memoryStorage() });

function logScriptEvent(
  req: AuthRequest,
  event: {
    action: string;
    severity?: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
    status?: string;
    message: string;
    metadata?: Record<string, unknown>;
    httpStatus?: number;
  }
): void {
  appLogService.enqueue({
    action: event.action,
    module: 'scripts',
    severity: event.severity || 'INFO',
    status: event.status || 'SUCCESS',
    userId: Number.isInteger(req.userId) ? req.userId as number : null,
    message: event.message,
    requestId: req.requestId || null,
    httpMethod: (req.method || '').toUpperCase() || null,
    httpPath: (req.originalUrl || req.path || '').split('?')[0] || null,
    httpStatus: Number.isInteger(event.httpStatus) ? event.httpStatus as number : null,
    metadata: event.metadata || null,
  });
}

function ensureWritableDirectory(dirPath: string): void {
  if (!dirPath) {
    throw new Error('Scripts workspace path is empty.');
  }

  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);

  const probeFile = path.join(dirPath, `.noesis-write-probe-${process.pid}-${Date.now()}`);
  fs.writeFileSync(probeFile, 'ok', { encoding: 'utf8' });

  // Best-effort cleanup; a temporary lock should not block script imports.
  if (fs.existsSync(probeFile)) {
    try {
      fs.unlinkSync(probeFile);
    } catch (error) {
      logger.warn(`Write probe cleanup failed for "${probeFile}": ${(error as Error).message}`);
    }
  }
}

function resolveScriptsWorkspacePath(): string {
  const configuredPath = (config.stAutomation?.path || '').trim();
  const fallbackPath = path.join(process.cwd(), 'scripts');
  const candidates = configuredPath
    ? [configuredPath, fallbackPath]
    : [fallbackPath];

  let lastError: string | null = null;

  for (const candidate of candidates) {
    try {
      ensureWritableDirectory(candidate);
      if (configuredPath && candidate !== configuredPath) {
        logger.warn(`Configured ST automation path is not writable. Falling back to ${candidate}`);
      }
      return candidate;
    } catch (error) {
      const message = (error as Error).message || 'Unknown workspace access error.';
      lastError = `${candidate}: ${message}`;
      logger.warn(`Cannot use scripts workspace path "${candidate}": ${message}`);
    }
  }

  throw new Error(lastError || 'No writable scripts workspace path available.');
}

function getAutomationSourceMode(): 'local' | 'git' {
  return config.stAutomation.source === 'git' ? 'git' : 'local';
}

function getScriptImportStoragePath(): string {
  if (getAutomationSourceMode() === 'git') {
    const configuredImportPath = (config.stAutomation.importPath || '').trim();
    const fallbackImportPath = path.join(process.cwd(), 'scripts');
    const importPath = configuredImportPath || fallbackImportPath;
    ensureWritableDirectory(importPath);
    return importPath;
  }

  return resolveScriptsWorkspacePath();
}

async function runGitCommand(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    const stderr = (err.stderr || '').toString().trim();
    const message = stderr || err.message || 'Unknown git error';
    throw new Error(message);
  }
}

function normalizeRepoUrl(repoUrl: string): string {
  return (repoUrl || '').trim().replace(/[\\/]+$/, '').toLowerCase();
}

async function resolveGitWorkspacePath(): Promise<string> {
  const repoUrl = (config.stAutomation.gitRepoUrl || '').trim();
  if (!repoUrl) {
    throw new Error('Git repository URL for automation source is not configured.');
  }

  const cachePath = (config.stAutomation.gitCachePath || '').trim() || path.join(process.cwd(), '.cache', 'automation-testing-repo');
  const gitMetadataPath = path.join(cachePath, '.git');

  if (!fs.existsSync(path.dirname(cachePath))) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  }

  if (!fs.existsSync(gitMetadataPath)) {
    if (fs.existsSync(cachePath) && fs.readdirSync(cachePath).length > 0) {
      throw new Error(`Git cache path "${cachePath}" is not empty and cannot be initialized.`);
    }

    await runGitCommand(['clone', '--depth', '1', repoUrl, cachePath]);
    return cachePath;
  }

  const remoteUrlResult = await runGitCommand(['-C', cachePath, 'remote', 'get-url', 'origin']);
  const existingRemoteUrl = remoteUrlResult.stdout.trim();
  if (normalizeRepoUrl(existingRemoteUrl) !== normalizeRepoUrl(repoUrl)) {
    throw new Error(`Git cache repository mismatch. Expected "${repoUrl}" but found "${existingRemoteUrl}".`);
  }

  await runGitCommand(['-C', cachePath, 'fetch', 'origin', '--prune', '--depth', '1']);

  const preferredBranch = (config.stAutomation.gitBranch || '').trim();
  if (preferredBranch) {
    await runGitCommand(['-C', cachePath, 'checkout', '-B', preferredBranch, `origin/${preferredBranch}`]);
    await runGitCommand(['-C', cachePath, 'reset', '--hard', `origin/${preferredBranch}`]);
  } else {
    await runGitCommand(['-C', cachePath, 'reset', '--hard', 'origin/HEAD']);
  }

  await runGitCommand(['-C', cachePath, 'clean', '-fd']);
  return cachePath;
}

async function resolveSyncSourceRoots(): Promise<SyncSourceRoot[]> {
  if (getAutomationSourceMode() === 'git') {
    const gitWorkspacePath = await resolveGitWorkspacePath();
    const importWorkspacePath = getScriptImportStoragePath();
    const roots: SyncSourceRoot[] = [{ rootPath: gitWorkspacePath, pathPrefix: '' }];

    if (path.resolve(importWorkspacePath) !== path.resolve(gitWorkspacePath)) {
      roots.push({ rootPath: importWorkspacePath, pathPrefix: 'imports' });
    }

    return roots;
  }

  return [{ rootPath: resolveScriptsWorkspacePath(), pathPrefix: '' }];
}

function isInsideRoot(rootPath: string, candidatePath: string): boolean {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedCandidate = path.resolve(candidatePath);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function buildStoredScriptPath(rootPath: string, absoluteFilePath: string, pathPrefix: string): string {
  const relativePath = path.relative(rootPath, absoluteFilePath).replace(/\\/g, '/');
  if (!pathPrefix) {
    return relativePath;
  }

  return `${pathPrefix}/${relativePath}`.replace(/\/+/g, '/');
}

function buildScriptNameFromFileName(fileName: string): string {
  return (fileName || '').replace(/\.java$/i, '').trim();
}

function hasTestLikeAnnotations(source: string): boolean {
  const cleaned = stripJavaComments(source);
  return /@\s*(Test|TestMetadata|ScriptMetadata)\b/.test(cleaned);
}

function isConfigurationArtifact(params: {
  relativePath: string;
  fileName: string;
  className: string;
  packageName: string | null;
  source: string;
}): boolean {
  const simpleName = (
    buildScriptNameFromFileName(params.fileName) || getSimpleClassName(params.className)
  ).toLowerCase();
  const normalizedPath = normalizePathForCompare(params.relativePath);
  const packageName = (params.packageName || '').toLowerCase();

  const hasConfigPathSegment = normalizedPath
    .split('/')
    .filter(Boolean)
    .some(segment => segment === 'config' || segment === 'configs');
  const hasConfigPackageSegment = packageName
    .split('.')
    .filter(Boolean)
    .some(segment => segment === 'config' || segment === 'configs');
  const classLooksConfig = simpleName.includes('config') || simpleName.includes('configuration');

  return !hasTestLikeAnnotations(params.source) && (
    hasConfigPathSegment ||
    hasConfigPackageSegment ||
    classLooksConfig
  );
}

function normalizePathForCompare(input: string): string {
  return (input || '').replace(/\\/g, '/').trim().toLowerCase();
}

function normalizeClassNameForCompare(className: string): string {
  return (className || '').trim().replace(/\s+/g, '').toLowerCase();
}

function getSimpleClassName(className: string): string {
  const cleanedClassName = (className || '').trim();
  if (!cleanedClassName) {
    return '';
  }

  const parts = cleanedClassName.split('.');
  return parts[parts.length - 1] || cleanedClassName;
}

function normalizeCategoryName(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCategoryLookup(rows: CategoryLookupRow[]): CategoryLookup {
  const sortedRows = [...rows].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  const byName = new Map<string, number>();

  for (const row of sortedRows) {
    const normalized = normalizeCategoryName(row.name);
    if (normalized) {
      byName.set(normalized, row.id);
    }
  }

  return {
    defaultId: sortedRows[0]?.id || 1,
    byName,
  };
}

function resolveCategoryIdByCandidates(lookup: CategoryLookup, candidates: string[]): number | null {
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeCategoryName(candidate);
    if (!normalizedCandidate) continue;

    const exact = lookup.byName.get(normalizedCandidate);
    if (exact) return exact;
  }

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeCategoryName(candidate);
    if (!normalizedCandidate) continue;

    for (const [knownName, id] of lookup.byName.entries()) {
      if (knownName.includes(normalizedCandidate) || normalizedCandidate.includes(knownName)) {
        return id;
      }
    }
  }

  return null;
}

function escapeRegexLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasWordToken(text: string, token: string): boolean {
  const pattern = new RegExp(`(^|[\\s./_\\-])${escapeRegexLiteral(token)}([\\s./_\\-]|$)`, 'i');
  return pattern.test(text);
}

function detectCategoryHint(params: {
  filePath: string;
  className: string;
  packageName: string | null;
  fileName: string;
}): 'configuration' | 'feature' | 'manual' | 'sanity' | 'api' | 'dashboard' | 'security' | 'intake' | null {
  const filePath = (params.filePath || '').toLowerCase();
  const className = (params.className || '').toLowerCase();
  const packageName = (params.packageName || '').toLowerCase();
  const fileName = (params.fileName || '').toLowerCase();
  const corpus = `${filePath} ${className} ${packageName} ${fileName}`;

  const score: Record<'configuration' | 'feature' | 'manual' | 'sanity' | 'api' | 'dashboard' | 'security' | 'intake', number> = {
    configuration: 0,
    feature: 0,
    manual: 0,
    sanity: 0,
    api: 0,
    dashboard: 0,
    security: 0,
    intake: 0,
  };

  const addIfContains = (category: keyof typeof score, terms: string[], points: number) => {
    for (const term of terms) {
      if (corpus.includes(term) || hasWordToken(corpus, term)) {
        score[category] += points;
      }
    }
  };

  addIfContains('api', ['api', 'rest', 'endpoint', 'http', 'request', 'response', 'serviceclient'], 4);
  addIfContains('security', ['security', 'auth', 'authorization', 'permission', 'role', 'sso', 'oauth', 'token', 'login', 'access'], 4);
  addIfContains('dashboard', ['dashboard', 'report', 'analytics', 'chart', 'monitor', 'worklist', 'logscreen'], 4);
  addIfContains('intake', ['intake', 'ingest', 'processing', 'processor', 'parser', 'extract', 'upload', 'pipeline', 'queue', 'import'], 4);
  addIfContains('manual', ['manual'], 5);
  addIfContains('sanity', ['sanity', 'smoke', 'healthcheck', 'health-check'], 5);
  addIfContains('configuration', ['configuration', 'config', 'setup', 'settings', 'preference'], 3);
  addIfContains('feature', ['feature', 'workflow', 'scenario', 'journey', 'functional'], 3);

  if (hasWordToken(filePath, 'api') || hasWordToken(packageName, 'api')) score.api += 3;
  if (hasWordToken(filePath, 'dashboard') || hasWordToken(packageName, 'dashboard')) score.dashboard += 3;
  if (hasWordToken(filePath, 'security') || hasWordToken(packageName, 'security')) score.security += 3;
  if (hasWordToken(filePath, 'intake') || hasWordToken(packageName, 'intake')) score.intake += 3;
  if (hasWordToken(filePath, 'manual') || hasWordToken(packageName, 'manual')) score.manual += 3;
  if (hasWordToken(filePath, 'sanity') || hasWordToken(packageName, 'sanity')) score.sanity += 3;
  if (hasWordToken(filePath, 'config') || hasWordToken(packageName, 'config')) score.configuration += 2;

  if (className.endsWith('test') || className.endsWith('tests')) {
    score.feature += 1;
  }

  const priorityOrder: Array<keyof typeof score> = [
    'api',
    'security',
    'dashboard',
    'intake',
    'manual',
    'sanity',
    'feature',
    'configuration',
  ];

  let best: keyof typeof score | null = null;
  let bestScore = 0;
  for (const category of priorityOrder) {
    if (score[category] > bestScore) {
      best = category;
      bestScore = score[category];
    }
  }

  return bestScore > 0 ? best : null;
}

function resolveCategoryIdForScript(
  lookup: CategoryLookup,
  params: {
    filePath: string;
    className: string;
    packageName: string | null;
    fileName: string;
  },
  fallbackCategoryId?: number
): number {
  const hint = detectCategoryHint(params);
  const candidateNameMap: Record<'configuration' | 'feature' | 'manual' | 'sanity' | 'api' | 'dashboard' | 'security' | 'intake', string[]> = {
    configuration: ['Configuration', 'Config'],
    feature: ['Feature', 'Functional'],
    manual: ['Manual'],
    sanity: ['Sanity', 'Smoke'],
    api: ['API', 'Api'],
    dashboard: ['Dashboard'],
    security: ['Security', 'Access Security'],
    intake: ['Intake', 'Intake and Processing', 'Intake & Processing'],
  };

  if (hint) {
    const resolvedId = resolveCategoryIdByCandidates(lookup, candidateNameMap[hint] || [hint]);
    if (resolvedId) {
      return resolvedId;
    }
  }

  if (fallbackCategoryId && Number.isInteger(fallbackCategoryId) && fallbackCategoryId > 0) {
    return fallbackCategoryId;
  }

  return lookup.defaultId;
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
    let paramIdx = 1;

    if (category) {
      sql += ` AND s.category_id = $${paramIdx++}`;
      params.push(Number(category));
    }
    if (search) {
      sql += ` AND (s.name ILIKE $${paramIdx} OR s.class_name ILIKE $${paramIdx + 1})`;
      params.push(`%${search}%`, `%${search}%`);
      paramIdx += 2;
    }
    if (active !== undefined) {
      sql += ` AND s.is_active = $${paramIdx++}`;
      params.push(active === 'true');
    }

    sql += ' ORDER BY sc.sort_order, s.name';

    const scripts = await query<ScriptRow>(sql, params);
    res.json(scripts.map(s => ({
      id: s.id,
      name: (s.name || '').replace(/\.java$/i, ''),
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
      tags: s.tags || [],
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
    const categories = await query<CategoryRow>(`
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
      scriptCount: Number(c.script_count),
    })));
  } catch (error) {
    logger.error('List categories error:', error);
    res.status(500).json({ error: 'Failed to fetch categories.' });
  }
});

// GET /api/scripts/:id - Get script details
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scripts = await query<ScriptRow>(`
      SELECT s.*, sc.name as category_name, sc.icon as category_icon, sc.color as category_color
      FROM scripts s
      JOIN script_categories sc ON s.category_id = sc.id
      WHERE s.id = $1
    `, [req.params.id]);

    if (scripts.length === 0) {
      res.status(404).json({ error: 'Script not found.' });
      return;
    }

    const s = scripts[0];
    res.json({
      id: s.id,
      name: (s.name || '').replace(/\.java$/i, ''),
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
      tags: s.tags || [],
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
    const scriptId = Number(req.params.id);
    if (!Number.isInteger(scriptId) || scriptId <= 0) {
      res.status(400).json({ error: 'Invalid script ID.' });
      return;
    }

    const existingScripts = await query<{ id: number; name: string }>(
      'SELECT id, name FROM scripts WHERE id = $1',
      [scriptId]
    );
    if (existingScripts.length === 0) {
      logScriptEvent(req, {
        action: 'SCRIPT_UPDATE',
        severity: 'WARN',
        status: 'NOOP',
        httpStatus: 404,
        message: `Update requested for script #${scriptId}, but it was not found.`,
        metadata: { scriptId },
      });
      res.status(404).json({ error: 'Script not found.' });
      return;
    }

    const sanitizedName = typeof name === 'string'
      ? name.replace(/\.java$/i, '').trim()
      : name;
    await execute(
      'UPDATE scripts SET name = COALESCE($1, name), description = COALESCE($2, description), method_name = COALESCE($3, method_name), is_active = COALESCE($4, is_active), tags = COALESCE($5, tags) WHERE id = $6',
      [sanitizedName, description, methodName, isActive, tags ? JSON.stringify(tags) : null, scriptId]
    );
    logScriptEvent(req, {
      action: 'SCRIPT_UPDATE',
      severity: 'INFO',
      status: 'SUCCESS',
      httpStatus: 200,
      message: `Script "${sanitizedName || existingScripts[0].name}" updated successfully.`,
      metadata: {
        scriptId,
        previousName: existingScripts[0].name,
        updatedName: sanitizedName || existingScripts[0].name,
      },
    });
    res.json({ message: 'Script updated.' });
  } catch (error) {
    logger.error('Update script error:', error);
    logScriptEvent(req, {
      action: 'SCRIPT_UPDATE',
      severity: 'ERROR',
      status: 'FAILED',
      httpStatus: 500,
      message: `Script update failed: ${(error as Error).message}`,
    });
    res.status(500).json({ error: 'Failed to update script.' });
  }
});

// POST /api/scripts/delete-multiple - Remove selected scripts
router.post('/delete-multiple', authorize('admin', 'tester'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const idsRaw = Array.isArray(req.body?.ids)
      ? req.body.ids
      : Array.isArray(req.body?.selectedIds)
        ? req.body.selectedIds
        : [];
    if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
      res.status(400).json({ error: 'At least one script ID is required.' });
      return;
    }

    const ids = Array.from(new Set(idsRaw.map((id: any) => Number(id)).filter((id: number) => Number.isInteger(id) && id > 0)));
    if (ids.length === 0) {
      res.status(400).json({ error: 'Invalid script IDs supplied.' });
      return;
    }

    const placeholders = ids.map((_, index) => `$${index + 1}`).join(',');
    const scriptsToDelete = await query<ScriptPathRow>(
      `SELECT id, name, file_path FROM scripts WHERE id IN (${placeholders})`,
      ids
    );

    if (scriptsToDelete.length === 0) {
      logScriptEvent(req, {
        action: 'SCRIPT_DELETE',
        severity: 'WARN',
        status: 'NOOP',
        httpStatus: 200,
        message: 'Delete requested, but selected scripts were already removed.',
        metadata: {
          requestedIds: ids,
          removedCount: 0,
          bulk: true,
        },
      });

      const [totalScripts] = await query<{ count: string }>(
        'SELECT COUNT(*)::text as count FROM scripts WHERE is_active = TRUE'
      );

      res.json({
        message: 'Selected scripts were already removed.',
        removedCount: 0,
        totals: {
          totalActiveScripts: Number(totalScripts?.count || 0),
        },
      });
      return;
    }

    await execute(`DELETE FROM scripts WHERE id IN (${placeholders})`, ids);
    for (const script of scriptsToDelete) {
      logScriptEvent(req, {
        action: 'SCRIPT_DELETE',
        severity: 'INFO',
        status: 'SUCCESS',
        httpStatus: 200,
        message: `Script "${script.name}" removed from database.`,
        metadata: {
          scriptId: script.id,
          scriptName: script.name,
          bulk: true,
          requestedIds: ids,
        },
      });
    }

    // Keep physical files in workspace. Deletion here is DB-only by design.

    const [totalScripts] = await query<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM scripts WHERE is_active = TRUE'
    );

    res.json({
      message: scriptsToDelete.length === 1 ? 'Script removed successfully.' : 'Scripts removed successfully.',
      removedCount: scriptsToDelete.length,
      totals: {
        totalActiveScripts: Number(totalScripts?.count || 0),
      },
    });
  } catch (error) {
    logger.error('Delete multiple scripts error:', error);
    res.status(500).json({ error: 'Failed to remove selected scripts.' });
  }
});

// DELETE /api/scripts/:id - Remove single script
router.delete('/:id', authorize('admin', 'tester'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scriptId = Number(req.params.id);
    if (!Number.isInteger(scriptId) || scriptId <= 0) {
      res.status(400).json({ error: 'Invalid script ID.' });
      return;
    }

    const scripts = await query<ScriptPathRow>(
      'SELECT id, name, file_path FROM scripts WHERE id = $1',
      [scriptId]
    );

    if (scripts.length === 0) {
      logScriptEvent(req, {
        action: 'SCRIPT_DELETE',
        severity: 'WARN',
        status: 'NOOP',
        httpStatus: 200,
        message: `Delete requested for script #${scriptId}, but it was already removed.`,
        metadata: {
          scriptId,
          removedCount: 0,
        },
      });

      const [totalScripts] = await query<{ count: string }>(
        'SELECT COUNT(*)::text as count FROM scripts WHERE is_active = TRUE'
      );

      res.json({
        message: 'Script already removed.',
        removedCount: 0,
        totals: {
          totalActiveScripts: Number(totalScripts?.count || 0),
        },
      });
      return;
    }

    await execute('DELETE FROM scripts WHERE id = $1', [scriptId]);
    logScriptEvent(req, {
      action: 'SCRIPT_DELETE',
      severity: 'INFO',
      status: 'SUCCESS',
      httpStatus: 200,
      message: `Script "${scripts[0].name}" removed from database.`,
      metadata: {
        scriptId,
        scriptName: scripts[0].name,
      },
    });
    // Keep physical file in workspace. Deletion here is DB-only by design.

    const [totalScripts] = await query<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM scripts WHERE is_active = TRUE'
    );

    res.json({
      message: 'Script removed successfully.',
      removedCount: 1,
      totals: {
        totalActiveScripts: Number(totalScripts?.count || 0),
      },
    });
  } catch (error) {
    logger.error('Delete script error:', error);
    res.status(500).json({ error: 'Failed to remove script.' });
  }
});

// POST /api/scripts/sync - Scan project and sync scripts
router.post('/sync', authorize('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const sourceRoots = await resolveSyncSourceRoots();

    // Recursively read all valid script files from the automation directory
    const getAllFiles = (dirPath: string, arrayOfFiles: string[] = []) => {
      const files = fs.readdirSync(dirPath);
      files.forEach(file => {
        const fullPath = path.join(dirPath, file);
        if (fs.statSync(fullPath).isDirectory()) {
          if (!['node_modules', 'target', '.git', 'bin', 'obj'].includes(file)) {
            arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
          }
        } else {
          if (file.match(/\.java$/i)) {
            arrayOfFiles.push(fullPath);
          }
        }
      });
      return arrayOfFiles;
    };

    const physicalFiles: Array<{ absolutePath: string; storedPath: string }> = [];
    for (const root of sourceRoots) {
      const files = getAllFiles(root.rootPath);
      for (const absolutePath of files) {
        const storedPath = buildStoredScriptPath(root.rootPath, absolutePath, root.pathPrefix);
        physicalFiles.push({ absolutePath, storedPath });
      }
    }

    const syncCandidates: Array<{
      absolutePath: string;
      storedPath: string;
      fileName: string;
      metadata: JavaScriptMetadata;
    }> = [];
    const skippedScripts: string[] = [];

    for (const fileInfo of physicalFiles) {
      const fileName = path.basename(fileInfo.absolutePath);
      try {
        const source = fs.readFileSync(fileInfo.absolutePath, 'utf8');
        const metadata = extractJavaScriptMetadata(source, fileName);

        if (isConfigurationArtifact({
          relativePath: fileInfo.storedPath,
          fileName,
          className: metadata.className,
          packageName: metadata.packageName,
          source,
        })) {
          continue;
        }

        syncCandidates.push({
          absolutePath: fileInfo.absolutePath,
          storedPath: fileInfo.storedPath,
          fileName,
          metadata,
        });
      } catch (readError) {
        skippedScripts.push(fileName);
        logger.warn(`Sync skipped "${fileName}": ${(readError as Error).message}`);
      }
    }

    const dbScripts = await query<ScriptSyncRow>(
      'SELECT id, name, class_name, category_id, file_path, is_active FROM scripts'
    );

    const addedScripts: string[] = [];
    const updatedScripts: string[] = [];
    const removedScripts: string[] = [];

    const categoryRows = await query<CategoryLookupRow>(
      'SELECT id, name, sort_order FROM script_categories ORDER BY sort_order'
    );
    const categoryLookup = buildCategoryLookup(categoryRows);

    const normalizeRelativePath = (value: string): string => normalizePathForCompare(value).replace(/^\.\//, '');
    const dbByPath = new Map<string, ScriptSyncRow>();
    const dbByClassName = new Map<string, ScriptSyncRow>();

    for (const script of dbScripts) {
      dbByPath.set(normalizeRelativePath(script.file_path), script);
      const classKey = normalizeClassNameForCompare(script.class_name);
      if (classKey) {
        dbByClassName.set(classKey, script);
      }
    }

    const physicalPaths = new Set(
      syncCandidates.map(fileInfo => normalizeRelativePath(fileInfo.storedPath))
    );
    const processedClassKeys = new Set<string>();

    // 1. Check for newly added scripts and existing scripts (update)
    for (const fileInfo of syncCandidates) {
      const relPath = fileInfo.storedPath;
      const normalizedRelPath = normalizeRelativePath(relPath);
      const fileName = fileInfo.fileName;
      const metadata = fileInfo.metadata;
      const className = metadata.className;
      const classKey = normalizeClassNameForCompare(className);
      const standardName = buildScriptNameFromFileName(fileName) || getSimpleClassName(className) || 'UnnamedScript';

      if (classKey && processedClassKeys.has(classKey)) {
        skippedScripts.push(fileName);
        continue;
      }
      if (classKey) {
        processedClassKeys.add(classKey);
      }

      try {
        let existingByPath = dbByPath.get(normalizedRelPath);
        let existingByClass = classKey ? dbByClassName.get(classKey) : undefined;
        const inferredCategoryId = resolveCategoryIdForScript(
          categoryLookup,
          {
            filePath: relPath,
            className,
            packageName: metadata.packageName,
            fileName,
          },
          existingByClass?.category_id ?? existingByPath?.category_id
        );

        if (existingByClass) {
          if (existingByPath && existingByPath.id !== existingByClass.id) {
            await execute('DELETE FROM scripts WHERE id = $1', [existingByPath.id]);
            removedScripts.push(existingByPath.name);

            dbByPath.delete(normalizedRelPath);
            const removedClassKey = normalizeClassNameForCompare(existingByPath.class_name);
            if (removedClassKey) {
              dbByClassName.delete(removedClassKey);
            }
            existingByPath = undefined;
          }

          await execute(
            'UPDATE scripts SET name = $1, class_name = $2, file_path = $3, category_id = $4, is_active = TRUE WHERE id = $5',
            [standardName, className, relPath, inferredCategoryId, existingByClass.id]
          );
          updatedScripts.push(standardName);

          const updatedRow: ScriptSyncRow = {
            ...existingByClass,
            name: standardName,
            class_name: className,
            category_id: inferredCategoryId,
            file_path: relPath,
            is_active: true,
          };
          dbByPath.set(normalizedRelPath, updatedRow);
          if (classKey) {
            dbByClassName.set(classKey, updatedRow);
          }
          continue;
        }

        if (existingByPath) {
          const oldClassKey = normalizeClassNameForCompare(existingByPath.class_name);
          await execute(
            'UPDATE scripts SET name = $1, class_name = $2, file_path = $3, category_id = $4, is_active = TRUE WHERE id = $5',
            [standardName, className, relPath, inferredCategoryId, existingByPath.id]
          );
          updatedScripts.push(standardName);

          const updatedRow: ScriptSyncRow = {
            ...existingByPath,
            name: standardName,
            class_name: className,
            category_id: inferredCategoryId,
            file_path: relPath,
            is_active: true,
          };
          dbByPath.set(normalizedRelPath, updatedRow);
          if (oldClassKey) {
            dbByClassName.delete(oldClassKey);
          }
          if (classKey) {
            dbByClassName.set(classKey, updatedRow);
          }
          continue;
        }

        const inserted = await execute(
          'INSERT INTO scripts (name, class_name, category_id, file_path, is_active) VALUES ($1, $2, $3, $4, TRUE) RETURNING id',
          [standardName, className, inferredCategoryId, relPath]
        );
        addedScripts.push(standardName);`r`n`r`n        // Increment user scripts_registered statistic`r`n        await execute('UPDATE users SET scripts_registered = scripts_registered + 1 WHERE id = $1', [req.userId]);

        const insertedId = Number(inserted.rows?.[0]?.id || 0);
        const insertedRow: ScriptSyncRow = {
          id: insertedId,
          name: standardName,
          class_name: className,
          category_id: inferredCategoryId,
          file_path: relPath,
          is_active: true,
        };
        dbByPath.set(normalizedRelPath, insertedRow);
        if (classKey) {
          dbByClassName.set(classKey, insertedRow);
        }
      } catch (fileError) {
        const err = fileError as { code?: string; message?: string };
        if (err?.code === '23505') {
          try {
            const recoverCategoryId = resolveCategoryIdForScript(categoryLookup, {
              filePath: relPath,
              className,
              packageName: metadata.packageName,
              fileName,
            });
            const conflictRows = await query<ScriptConflictRow>(
              `SELECT id, name, class_name, file_path, is_active
               FROM scripts
               WHERE LOWER(class_name) = LOWER($1)
                  OR LOWER(file_path) = LOWER($2)
               LIMIT 1`,
              [className, relPath]
            );

            if (conflictRows.length > 0) {
              await execute(
                'UPDATE scripts SET name = $1, class_name = $2, file_path = $3, category_id = $4, is_active = TRUE WHERE id = $5',
                [standardName, className, relPath, recoverCategoryId, conflictRows[0].id]
              );
              updatedScripts.push(standardName);
              continue;
            }
          } catch (recoverError) {
            logger.warn(`Sync conflict recovery failed for "${fileName}": ${(recoverError as Error).message}`);
          }
        }

        skippedScripts.push(fileName);
        logger.warn(`Sync skipped "${fileName}": ${err?.message || 'Unknown error'}`);
      }
    }

    // 2. Clean up orphaned scripts from the database
    const scriptsAfterUpsert = await query<ScriptPathRow>(
      'SELECT id, name, file_path FROM scripts'
    );
    for (const dbScript of scriptsAfterUpsert) {
      const normalizedDbPath = normalizeRelativePath(dbScript.file_path);
      if (!physicalPaths.has(normalizedDbPath)) {
        await execute('DELETE FROM scripts WHERE id = $1', [dbScript.id]);
        removedScripts.push(dbScript.name);
      }
    }

    const hasWarnings = skippedScripts.length > 0;
    logScriptEvent(req, {
      action: 'WORKSPACE_SYNC',
      severity: hasWarnings ? 'WARN' : 'INFO',
      status: hasWarnings ? 'PARTIAL_SUCCESS' : 'SUCCESS',
      httpStatus: 200,
      message: hasWarnings
        ? 'Workspace sync completed with warnings.'
        : 'Workspace sync completed successfully.',
      metadata: {
        addedCount: addedScripts.length,
        updatedCount: updatedScripts.length,
        removedCount: removedScripts.length,
        skippedCount: skippedScripts.length,
        addedScripts: addedScripts.slice(0, 30),
        updatedScripts: updatedScripts.slice(0, 30),
        removedScripts: removedScripts.slice(0, 30),
        skippedScripts: skippedScripts.slice(0, 30),
      },
    });

    res.json({
      message: hasWarnings ? 'Sync completed with warnings' : 'Sync completed successfully',
      stats: {
        added: addedScripts.length,
        updated: updatedScripts.length,
        removed: removedScripts.length,
        skipped: skippedScripts.length
      },
      details: {
        added: addedScripts,
        updated: updatedScripts,
        removed: removedScripts,
        skipped: skippedScripts
      }
    });
  } catch (error) {
    logger.error('Sync scripts error:', error);
    logScriptEvent(req, {
      action: 'WORKSPACE_SYNC',
      severity: 'ERROR',
      status: 'FAILED',
      httpStatus: 500,
      message: `Workspace sync failed: ${(error as Error).message}`,
    });
    res.status(500).json({ error: 'Failed to sync scripts.' });
  }
});

// POST /api/scripts/import - Import a single script file manually
router.post('/import', authorize('admin', 'tester'), upload.single('file'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'No file uploaded.' });
      return;
    }

    const sanitizedFileName = path.basename(file.originalname || '').trim();
    if (!sanitizedFileName || !/\.java$/i.test(sanitizedFileName)) {
      res.status(400).json({ error: 'Only .java files are supported.' });
      return;
    }

    const importBasePath = getScriptImportStoragePath();

    const javaSource = file.buffer.toString('utf8');
    const metadata = extractJavaScriptMetadata(javaSource, sanitizedFileName);
    const targetPath = path.join(importBasePath, sanitizedFileName);
    const relPath = getAutomationSourceMode() === 'git'
      ? `imports/${sanitizedFileName}`
      : path.relative(importBasePath, targetPath).replace(/\\/g, '/');
    const standardName = buildScriptNameFromFileName(sanitizedFileName) || getSimpleClassName(metadata.className) || 'UnnamedScript';

    if (isConfigurationArtifact({
      relativePath: relPath,
      fileName: sanitizedFileName,
      className: metadata.className,
      packageName: metadata.packageName,
      source: javaSource,
    })) {
      logScriptEvent(req, {
        action: 'SCRIPT_IMPORT_REJECTED',
        severity: 'WARN',
        status: 'CLIENT_ERROR',
        httpStatus: 422,
        message: `Import rejected for "${sanitizedFileName}" because it is a configuration artifact.`,
        metadata: {
          fileName: sanitizedFileName,
          className: metadata.className,
        },
      });
      res.status(422).json({ error: 'Configuration files cannot be imported as scripts.' });
      return;
    }

    const categoryRows = await query<CategoryLookupRow>(
      'SELECT id, name, sort_order FROM script_categories ORDER BY sort_order'
    );
    const categoryLookup = buildCategoryLookup(categoryRows);
    const categoryId = resolveCategoryIdForScript(categoryLookup, {
      filePath: relPath,
      className: metadata.className,
      packageName: metadata.packageName,
      fileName: sanitizedFileName,
    });

    // Duplicate protection: strict match on file path OR fully qualified class name.
    const pathKey = normalizePathForCompare(relPath);
    const classKey = normalizeClassNameForCompare(metadata.className);
    const existingConflicts = await query<ScriptConflictRow>(
      `SELECT id, name, class_name, file_path, is_active
       FROM scripts
       WHERE LOWER(file_path) = LOWER($1)
          OR LOWER(class_name) = LOWER($2)
       ORDER BY id DESC`,
      [relPath, metadata.className]
    );

    const matchingConflicts = existingConflicts.filter(conflict =>
      normalizePathForCompare(conflict.file_path) === pathKey ||
      (classKey !== '' && normalizeClassNameForCompare(conflict.class_name) === classKey)
    );
    const activeConflict = matchingConflicts.find(conflict => conflict.is_active);
    const inactiveConflict = matchingConflicts.find(conflict => !conflict.is_active);

    if (activeConflict) {
      logScriptEvent(req, {
        action: 'SCRIPT_IMPORT_DUPLICATE',
        severity: 'WARN',
        status: 'CLIENT_ERROR',
        httpStatus: 409,
        message: `Duplicate script import blocked for "${sanitizedFileName}".`,
        metadata: {
          fileName: sanitizedFileName,
          className: metadata.className,
          existingScriptId: activeConflict.id,
        },
      });
      res.status(409).json({
        error: 'Duplicate script import is not allowed. The script is already registered.',
      });
      return;
    }

    // Write file to workspace after validation.
    // If a soft-deleted row exists (legacy behavior), restore it instead of creating a duplicate.
    fs.writeFileSync(targetPath, file.buffer);

    if (inactiveConflict) {
      await execute(
        'UPDATE scripts SET name = $1, class_name = $2, category_id = $3, file_path = $4, is_active = TRUE WHERE id = $5',
        [standardName, metadata.className, categoryId, relPath, inactiveConflict.id]
      );
      logScriptEvent(req, {
        action: 'SCRIPT_IMPORT',
        severity: 'INFO',
        status: 'SUCCESS',
        httpStatus: 200,
        message: `Script "${standardName}" restored from previous inactive record.`,
        metadata: {
          scriptId: inactiveConflict.id,
          fileName: sanitizedFileName,
          className: metadata.className,
          categoryId,
          filePath: relPath,
        },
      });

      const [totalScripts] = await query<{ count: string }>(
        'SELECT COUNT(*)::text as count FROM scripts WHERE is_active = TRUE'
      );

      res.status(200).json({
        message: 'Script imported successfully',
        action: 'restored',
        script: {
          id: inactiveConflict.id,
          name: standardName,
          className: metadata.className,
          packageName: metadata.packageName,
          filePath: relPath,
          categoryId,
        },
        totals: {
          totalActiveScripts: Number(totalScripts?.count || 0),
        },
      });
      return;
    }

    await execute(
      'INSERT INTO scripts (name, class_name, category_id, file_path, is_active) VALUES ($1, $2, $3, $4, TRUE)',
      [standardName, metadata.className, categoryId, relPath]
    );

    // Increment user scripts_registered statistic
    await execute('UPDATE users SET scripts_registered = scripts_registered + 1 WHERE id = $1', [req.userId]);
    logScriptEvent(req, {
      action: 'SCRIPT_IMPORT',
      severity: 'INFO',
      status: 'SUCCESS',
      httpStatus: 201,
      message: `Script "${standardName}" imported successfully.`,
      metadata: {
        fileName: sanitizedFileName,
        className: metadata.className,
        categoryId,
        filePath: relPath,
      },
    });

    const [totalScripts] = await query<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM scripts WHERE is_active = TRUE'
    );

    res.status(201).json({
      message: 'Script imported successfully',
      action: 'created',
      script: {
        name: standardName,
        className: metadata.className,
        packageName: metadata.packageName,
        filePath: relPath,
        categoryId,
      },
      totals: {
        totalActiveScripts: Number(totalScripts?.count || 0),
      },
    });
  } catch (error) {
    logger.error('Import script error:', error);
    const err = error as { code?: string; message?: string };
    logScriptEvent(req, {
      action: 'SCRIPT_IMPORT',
      severity: 'ERROR',
      status: err?.code === '23505' ? 'CLIENT_ERROR' : 'FAILED',
      httpStatus: err?.code === '23505' ? 409 : 500,
      message: `Script import failed: ${err?.message || 'Unknown error'}`,
    });
    if (err?.code === '23505') {
      res.status(409).json({ error: 'Script already exists.' });
      return;
    }
    res.status(500).json({ error: err?.message || 'Failed to import script.' });
  }
});

function stripJavaComments(source: string): string {
  return (source || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\r\n]*/g, '');
}

function extractJavaScriptMetadata(source: string, fileName: string): JavaScriptMetadata {
  const fallbackClassName = fileName.replace(/\.java$/i, '');
  const sourceWithoutComments = stripJavaComments(source);
  const packageMatch = sourceWithoutComments.match(/^\s*package\s+([a-zA-Z_][\w.]*)\s*;/m);
  const classMatch = sourceWithoutComments.match(
    /^\s*(?:(?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)\b/m
  );

  const simpleClassName = classMatch?.[1] || fallbackClassName;
  const packageName = packageMatch?.[1] || null;

  return {
    className: packageName ? `${packageName}.${simpleClassName}` : simpleClassName,
    packageName,
  };
}

export default router;
