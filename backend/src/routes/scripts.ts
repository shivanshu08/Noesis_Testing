import { Router, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
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

interface ScriptDetailsRow extends ScriptRow {
  updated_at: Date;
  created_by: number | null;
  created_by_name: string | null;
}

type ScriptResourceType = 'java_config' | 'json' | 'attachment' | 'data_file';
type ScriptResourceSourceKind = 'parser' | 'persisted';

interface ScriptConfigurationResourceRecordRow {
  resource_type: string;
  reference_value: string;
  resolved_path: string | null;
  exists_on_disk: boolean;
  source_kind: string;
  metadata: Record<string, unknown> | null;
  updated_at: Date;
}

interface ScriptRunHistoryRow {
  run_id: number;
  run_name: string;
  run_status: string;
  result_status: string;
  environment: string;
  started_at: Date | null;
  completed_at: Date | null;
  run_duration_ms: number | null;
  script_duration_ms: number | null;
  triggered_by_name: string | null;
}

interface ScriptExecutionSummaryRow {
  total_runs: number;
  passed_runs: number;
  failed_runs: number;
  error_runs: number;
  skipped_runs: number;
  average_script_duration_ms: number | null;
  unique_executors: number;
}

interface ScriptArtifactRow {
  id: number;
  run_id: number;
  artifact_type: string;
  file_name: string;
  stored_path: string;
  file_size_bytes: number | null;
  mime_type: string | null;
  created_at: Date;
  run_name: string | null;
  run_status: string | null;
  run_started_at: Date | null;
}

interface ResolvedScriptLocation {
  absolutePath: string | null;
  bestEffortPath: string | null;
  sourceRoots: SyncSourceRoot[];
}

interface ScriptResourceCandidate {
  type: ScriptResourceType;
  reference: string;
  resolvedPath: string | null;
  existsOnDisk: boolean;
  sourceKind: ScriptResourceSourceKind;
  metadata?: Record<string, unknown>;
}

interface EditableScriptConfigFile {
  path: string;
  fileType: 'java' | 'json';
  reference: string;
  sourceType: ScriptResourceType;
  existsOnDisk: boolean;
  fileSizeBytes: number | null;
  lastModifiedAt: Date | null;
}

interface ScriptConfigChangeLogRow {
  id: number;
  script_id: number;
  file_path: string;
  file_type: string;
  previous_content: string | null;
  updated_content: string | null;
  change_summary: Record<string, unknown> | null;
  changed_by: number | null;
  changed_at: Date;
  changed_by_name: string | null;
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

function resolveReadOnlySourceRoots(): SyncSourceRoot[] {
  if (getAutomationSourceMode() === 'git') {
    const gitCacheCandidates = [
      (config.stAutomation.gitCachePath || '').trim(),
      path.join(process.cwd(), '.cache', 'automation-testing-repo'),
      path.join(process.cwd(), 'backend', '.cache', 'automation-testing-repo'),
    ].filter(Boolean);

    const gitWorkspacePath = gitCacheCandidates.find(candidate => fs.existsSync(candidate)) || gitCacheCandidates[0] || '';
    const importWorkspacePath = (config.stAutomation.importPath || '').trim() || path.join(process.cwd(), 'scripts');
    const roots: SyncSourceRoot[] = [];

    if (gitWorkspacePath) {
      roots.push({ rootPath: gitWorkspacePath, pathPrefix: '' });
    }

    if (importWorkspacePath) {
      const importRoot = path.resolve(importWorkspacePath);
      const gitRoot = gitWorkspacePath ? path.resolve(gitWorkspacePath) : '';
      if (!gitRoot || importRoot !== gitRoot) {
        roots.push({ rootPath: importWorkspacePath, pathPrefix: 'imports' });
      }
    }

    return roots.filter(root => root.rootPath);
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

const JAVA_CONFIG_EXTENSIONS = new Set(['.properties', '.prop', '.xml', '.yaml', '.yml', '.conf', '.ini']);
const JSON_EXTENSIONS = new Set(['.json']);
const ATTACHMENT_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.csv', '.xls', '.xlsx',
  '.doc', '.docx', '.zip', '.rar', '.7z', '.txt', '.log',
]);
const DATA_FILE_EXTENSIONS = new Set(['.sql', '.tsv', '.dat']);

function normalizeStoredRelativePath(value: string): string {
  return (value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .trim();
}

function stripKnownResourcePrefixes(value: string): string {
  return value.replace(/^(classpath:|file:)/i, '').trim();
}

function formatPathForResponse(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/\\/g, '/');
}

function getMimeTypeForFile(filePath: string): string {
  const extension = path.extname((filePath || '').toLowerCase());
  const mimeByExtension: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.log': 'text/plain; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.zip': 'application/zip',
    '.rar': 'application/vnd.rar',
    '.7z': 'application/x-7z-compressed',
  };
  return mimeByExtension[extension] || 'application/octet-stream';
}

function normalizeResourceReference(value: string): string {
  return normalizeStoredRelativePath(stripKnownResourcePrefixes(value))
    .replace(/[?#].*$/, '')
    .trim();
}

function decodeJavaStringLiteral(value: string): string {
  const escapeMap: Record<string, string> = {
    n: '\n',
    r: '\r',
    t: '\t',
    b: '\b',
    f: '\f',
    '"': '"',
    "'": "'",
    '\\': '\\',
  };

  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_full, hex) => {
      const parsed = Number.parseInt(hex, 16);
      return Number.isNaN(parsed) ? '' : String.fromCharCode(parsed);
    })
    .replace(/\\([nrtbf"'\\])/g, (_full, token) => escapeMap[token] ?? token);
}

function extractJavaStringLiterals(source: string): string[] {
  const cleaned = stripJavaComments(source);
  const literals: string[] = [];
  const seen = new Set<string>();
  const pattern = /"((?:\\.|[^"\\])*)"/g;
  let match: RegExpExecArray | null = null;

  while ((match = pattern.exec(cleaned))) {
    const rawLiteral = (match[1] || '').trim();
    if (!rawLiteral || rawLiteral.length > 700) {
      continue;
    }

    const decodedLiteral = decodeJavaStringLiteral(rawLiteral).trim();
    if (!decodedLiteral || decodedLiteral.includes('${') || decodedLiteral.includes('%s')) {
      continue;
    }

    if (seen.has(decodedLiteral)) {
      continue;
    }

    seen.add(decodedLiteral);
    literals.push(decodedLiteral);
  }

  return literals;
}

function classifyReferencedResource(reference: string): ScriptResourceType | null {
  const normalized = normalizeResourceReference(reference).toLowerCase();
  if (!normalized || /^(https?:|jdbc:|data:|mailto:)/i.test(normalized)) {
    return null;
  }

  const extension = path.extname(normalized);
  if (!extension) {
    if (normalized.includes('/config/') || normalized.includes('/configs/')) {
      return 'java_config';
    }
    return null;
  }

  if (JSON_EXTENSIONS.has(extension)) {
    return 'json';
  }
  if (JAVA_CONFIG_EXTENSIONS.has(extension)) {
    return 'java_config';
  }
  if (ATTACHMENT_EXTENSIONS.has(extension)) {
    return 'attachment';
  }
  if (DATA_FILE_EXTENSIONS.has(extension)) {
    return 'data_file';
  }

  return null;
}

function resolveAbsolutePathFromStoredPath(storedPath: string, sourceRoots: SyncSourceRoot[]): ResolvedScriptLocation {
  const normalizedStoredPath = normalizeStoredRelativePath(storedPath);
  if (!normalizedStoredPath) {
    return { absolutePath: null, bestEffortPath: null, sourceRoots };
  }

  if (path.isAbsolute(normalizedStoredPath) && fs.existsSync(normalizedStoredPath)) {
    return {
      absolutePath: normalizedStoredPath,
      bestEffortPath: normalizedStoredPath,
      sourceRoots,
    };
  }

  let bestEffortPath: string | null = null;

  for (const root of sourceRoots) {
    const normalizedPrefix = normalizeStoredRelativePath(root.pathPrefix);
    let relativeWithinRoot = normalizedStoredPath;

    if (normalizedPrefix) {
      if (normalizedStoredPath === normalizedPrefix) {
        continue;
      }
      if (normalizedStoredPath.startsWith(`${normalizedPrefix}/`)) {
        relativeWithinRoot = normalizedStoredPath.slice(normalizedPrefix.length + 1);
      }
    }

    if (!relativeWithinRoot) {
      continue;
    }

    const candidate = path.resolve(root.rootPath, relativeWithinRoot);
    if (!isInsideRoot(root.rootPath, candidate)) {
      continue;
    }

    if (!bestEffortPath) {
      bestEffortPath = candidate;
    }

    if (fs.existsSync(candidate)) {
      return { absolutePath: candidate, bestEffortPath: candidate, sourceRoots };
    }
  }

  return { absolutePath: null, bestEffortPath, sourceRoots };
}

async function resolveScriptLocation(storedPath: string): Promise<ResolvedScriptLocation> {
  const sourceRoots = resolveReadOnlySourceRoots();
  return resolveAbsolutePathFromStoredPath(storedPath, sourceRoots);
}

function resolveResourceReferencePath(
  reference: string,
  context: { scriptAbsolutePath: string | null; sourceRoots: SyncSourceRoot[] }
): { resolvedPath: string | null; existsOnDisk: boolean } {
  const rawReference = stripKnownResourcePrefixes(reference).trim();
  const normalizedReference = normalizeResourceReference(rawReference);

  if (!normalizedReference || normalizedReference.includes('${')) {
    return { resolvedPath: null, existsOnDisk: false };
  }

  if (/^(https?:|jdbc:|data:|mailto:)/i.test(normalizedReference)) {
    return { resolvedPath: null, existsOnDisk: false };
  }

  const candidates: string[] = [];
  const seen = new Set<string>();

  const registerCandidate = (candidate: string, rootPath?: string) => {
    if (!candidate) return;
    const resolvedCandidate = path.resolve(candidate);
    if (rootPath && !isInsideRoot(rootPath, resolvedCandidate)) {
      return;
    }
    if (seen.has(resolvedCandidate)) {
      return;
    }
    seen.add(resolvedCandidate);
    candidates.push(resolvedCandidate);
  };

  const registerRootRelativeCandidates = (rootPath: string, relativePath: string) => {
    if (!rootPath || !relativePath) return;

    // Classpath-style references are usually rooted in resources directories.
    const relativeVariants = new Set<string>([relativePath]);
    if (relativePath.startsWith('src/main/resources/')) {
      relativeVariants.add(relativePath.slice('src/main/resources/'.length));
    }
    if (relativePath.startsWith('src/test/resources/')) {
      relativeVariants.add(relativePath.slice('src/test/resources/'.length));
    }
    if (relativePath.startsWith('resources/')) {
      relativeVariants.add(relativePath.slice('resources/'.length));
    }

    for (const variant of relativeVariants) {
      if (!variant) continue;
      registerCandidate(path.resolve(rootPath, variant), rootPath);
      registerCandidate(path.resolve(rootPath, 'src/main/resources', variant), rootPath);
      registerCandidate(path.resolve(rootPath, 'src/test/resources', variant), rootPath);
      registerCandidate(path.resolve(rootPath, 'resources', variant), rootPath);
    }
  };

  if (path.isAbsolute(rawReference)) {
    registerCandidate(rawReference);
  }

  if (context.scriptAbsolutePath) {
    const baseDir = path.dirname(context.scriptAbsolutePath);
    registerCandidate(path.resolve(baseDir, rawReference));
    if (rawReference !== normalizedReference) {
      registerCandidate(path.resolve(baseDir, normalizedReference));
    }
  }

  for (const root of context.sourceRoots) {
    const prefix = normalizeStoredRelativePath(root.pathPrefix);
    let relativePath = normalizedReference;
    if (prefix && normalizedReference.startsWith(`${prefix}/`)) {
      relativePath = normalizedReference.slice(prefix.length + 1);
    }

    if (!relativePath) continue;
    registerRootRelativeCandidates(root.rootPath, relativePath);
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { resolvedPath: formatPathForResponse(candidate), existsOnDisk: true };
    }
  }

  const fallbackFileName = path.basename(normalizedReference);
  if (fallbackFileName && path.extname(fallbackFileName)) {
    for (const root of context.sourceRoots) {
      const foundPath = findFileByNameInRoot(root.rootPath, fallbackFileName);
      if (foundPath) {
        return { resolvedPath: formatPathForResponse(foundPath), existsOnDisk: true };
      }
    }
  }

  return {
    resolvedPath: candidates.length > 0 ? formatPathForResponse(candidates[0]) : null,
    existsOnDisk: false,
  };
}

function resolveJavaImportSourcePath(
  importReference: string,
  sourceRoots: SyncSourceRoot[]
): { resolvedPath: string | null; existsOnDisk: boolean } {
  const cleanedImport = (importReference || '')
    .replace(/^\s*static\s+/i, '')
    .trim();

  if (!cleanedImport || cleanedImport.endsWith('.*')) {
    return { resolvedPath: null, existsOnDisk: false };
  }

  const importPath = cleanedImport.replace(/\./g, '/');
  const relativeCandidates = [
    `${importPath}.java`,
    `${importPath}.json`,
    `${importPath}.properties`,
    `${importPath}.xml`,
    `${importPath}.yaml`,
    `${importPath}.yml`,
    `src/main/java/${importPath}.java`,
    `src/test/java/${importPath}.java`,
    `main/java/${importPath}.java`,
    `test/java/${importPath}.java`,
    `src/main/resources/${importPath}.properties`,
    `src/test/resources/${importPath}.properties`,
  ];

  for (const root of sourceRoots) {
    for (const relativePath of relativeCandidates) {
      const candidatePath = path.resolve(root.rootPath, relativePath);
      if (!isInsideRoot(root.rootPath, candidatePath)) {
        continue;
      }
      if (fs.existsSync(candidatePath)) {
        return { resolvedPath: formatPathForResponse(candidatePath), existsOnDisk: true };
      }
    }
  }

  const simpleClassName = cleanedImport.split('.').pop() || '';
  if (simpleClassName) {
    for (const root of sourceRoots) {
      const foundJavaPath = findFileByNameInRoot(root.rootPath, `${simpleClassName}.java`);
      if (foundJavaPath) {
        return { resolvedPath: formatPathForResponse(foundJavaPath), existsOnDisk: true };
      }
    }
  }

  return { resolvedPath: null, existsOnDisk: false };
}

function findFileByNameInRoot(rootPath: string, targetFileName: string): string | null {
  if (!rootPath || !targetFileName || !fs.existsSync(rootPath)) {
    return null;
  }

  const skipDirectories = new Set(['node_modules', 'target', '.git', 'bin', 'obj', 'dist', 'build', '.cache']);
  const stack: Array<{ dirPath: string; depth: number }> = [{ dirPath: rootPath, depth: 0 }];
  const maxDepth = 7;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current.depth > maxDepth) continue;

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current.dirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skipDirectories.has(entry.name.toLowerCase())) {
          continue;
        }
        stack.push({
          dirPath: path.join(current.dirPath, entry.name),
          depth: current.depth + 1,
        });
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase() === targetFileName.toLowerCase()) {
        return path.join(current.dirPath, entry.name);
      }
    }
  }

  return null;
}

function buildJavaImportConfigurationCandidates(
  imports: string[],
  context: { sourceRoots: SyncSourceRoot[] }
): ScriptResourceCandidate[] {
  const seen = new Set<string>();
  const candidates: ScriptResourceCandidate[] = [];

  for (const value of imports) {
    const reference = (value || '').trim();
    if (!reference || seen.has(reference)) {
      continue;
    }

    const lowerValue = reference.toLowerCase();
    const isConfigImport = lowerValue.includes('.config.')
      || lowerValue.endsWith('.config')
      || lowerValue.includes('configuration')
      || lowerValue.endsWith('config')
      || lowerValue.endsWith('properties');
    if (!isConfigImport) {
      continue;
    }

    const resolved = resolveJavaImportSourcePath(reference, context.sourceRoots);
    if (!resolved.existsOnDisk) {
      continue;
    }

    seen.add(reference);
    candidates.push({
      type: 'java_config',
      reference,
      resolvedPath: resolved.resolvedPath,
      existsOnDisk: resolved.existsOnDisk,
      sourceKind: 'parser',
      metadata: {
        detectedFrom: 'java_import',
        importReference: reference,
      },
    });
  }

  return candidates;
}

function buildSourceResourceCandidates(
  source: string,
  context: { scriptAbsolutePath: string | null; sourceRoots: SyncSourceRoot[] }
): ScriptResourceCandidate[] {
  const stringLiterals = extractJavaStringLiterals(source);
  const candidates: ScriptResourceCandidate[] = [];

  for (const literal of stringLiterals) {
    const type = classifyReferencedResource(literal);
    if (!type) continue;

    const normalizedReference = normalizeResourceReference(literal);
    if (!normalizedReference) continue;

    const resolved = resolveResourceReferencePath(normalizedReference, context);
    candidates.push({
      type,
      reference: normalizedReference,
      resolvedPath: resolved.resolvedPath,
      existsOnDisk: resolved.existsOnDisk,
      sourceKind: 'parser',
      metadata: {
        extension: path.extname(normalizedReference).toLowerCase() || null,
        detectedFrom: 'string_literal',
      },
    });
  }

  return candidates;
}

function buildLinkedJavaConfigResourceCandidates(
  resources: ScriptResourceCandidate[],
  context: { sourceRoots: SyncSourceRoot[] }
): ScriptResourceCandidate[] {
  const queue: Array<{ filePath: string; depth: number; reference: string }> = [];
  const visited = new Set<string>();
  const aggregated: ScriptResourceCandidate[] = [];
  const maxDepth = 3;

  for (const resource of resources) {
    if (resource.type !== 'java_config' || !resource.existsOnDisk || !resource.resolvedPath) {
      continue;
    }

    if (resolveEditableFileType(resource.resolvedPath) !== 'java') {
      continue;
    }

    queue.push({
      filePath: resource.resolvedPath,
      depth: 0,
      reference: resource.reference || path.basename(resource.resolvedPath),
    });
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const pathKey = normalizeAbsolutePathForCompare(current.filePath);
    if (visited.has(pathKey)) {
      continue;
    }
    visited.add(pathKey);

    if (!fs.existsSync(current.filePath)) {
      continue;
    }

    let source = '';
    try {
      source = fs.readFileSync(current.filePath, 'utf8');
    } catch {
      continue;
    }

    const javaSignals = parseJavaSignals(source, path.basename(current.filePath));
    const importDerived = buildJavaImportConfigurationCandidates(javaSignals.imports, {
      sourceRoots: context.sourceRoots,
    });
    const literalDerived = buildSourceResourceCandidates(source, {
      scriptAbsolutePath: current.filePath,
      sourceRoots: context.sourceRoots,
    });

    for (const candidate of [...importDerived, ...literalDerived]) {
      aggregated.push({
        ...candidate,
        metadata: {
          ...toSafeMetadataObject(candidate.metadata),
          parentConfigReference: current.reference,
          parentConfigPath: formatPathForResponse(current.filePath),
          discoveredDepth: current.depth + 1,
          discoveredFrom: 'linked_java_config',
        },
      });

      if (
        current.depth < maxDepth &&
        candidate.type === 'java_config' &&
        candidate.existsOnDisk &&
        !!candidate.resolvedPath &&
        resolveEditableFileType(candidate.resolvedPath) === 'java'
      ) {
        queue.push({
          filePath: candidate.resolvedPath,
          depth: current.depth + 1,
          reference: candidate.reference || path.basename(candidate.resolvedPath),
        });
      }
    }
  }

  return dedupeScriptResourceCandidates(aggregated);
}

function collectJsonStringLiterals(value: unknown, sink: Set<string>, depth = 0): void {
  if (depth > 12 || sink.size > 1200) {
    return;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed && trimmed.length <= 1200) {
      sink.add(trimmed);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonStringLiterals(item, sink, depth + 1);
      if (sink.size > 1200) break;
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  for (const nested of Object.values(value as Record<string, unknown>)) {
    collectJsonStringLiterals(nested, sink, depth + 1);
    if (sink.size > 1200) break;
  }
}

function buildJsonDerivedResourceCandidates(
  resources: ScriptResourceCandidate[],
  context: { sourceRoots: SyncSourceRoot[] }
): ScriptResourceCandidate[] {
  const queue: Array<{ filePath: string; depth: number }> = [];
  const visited = new Set<string>();
  const discovered: ScriptResourceCandidate[] = [];
  const maxDepth = 2;

  for (const resource of resources) {
    if (resource.type !== 'json' || !resource.existsOnDisk || !resource.resolvedPath) {
      continue;
    }
    queue.push({ filePath: resource.resolvedPath, depth: 0 });
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    const pathKey = normalizeAbsolutePathForCompare(current.filePath);
    if (visited.has(pathKey)) {
      continue;
    }
    visited.add(pathKey);

    if (!fs.existsSync(current.filePath)) {
      continue;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(fs.readFileSync(current.filePath, 'utf8'));
    } catch {
      continue;
    }

    const stringLiterals = new Set<string>();
    collectJsonStringLiterals(parsedJson, stringLiterals);

    for (const literal of stringLiterals) {
      const type = classifyReferencedResource(literal);
      if (!type) continue;

      const normalizedReference = normalizeResourceReference(literal);
      if (!normalizedReference) continue;

      const resolved = resolveResourceReferencePath(normalizedReference, {
        scriptAbsolutePath: current.filePath,
        sourceRoots: context.sourceRoots,
      });

      discovered.push({
        type,
        reference: normalizedReference,
        resolvedPath: resolved.resolvedPath,
        existsOnDisk: resolved.existsOnDisk,
        sourceKind: 'parser',
        metadata: {
          detectedFrom: 'json_value',
          parentJsonFile: path.basename(current.filePath),
          parentJsonPath: formatPathForResponse(current.filePath),
          discoveredDepth: current.depth + 1,
        },
      });

      if (
        current.depth < maxDepth &&
        type === 'json' &&
        resolved.existsOnDisk &&
        !!resolved.resolvedPath
      ) {
        queue.push({
          filePath: resolved.resolvedPath,
          depth: current.depth + 1,
        });
      }
    }
  }

  return dedupeScriptResourceCandidates(discovered);
}

function dedupeScriptResourceCandidates(resources: ScriptResourceCandidate[]): ScriptResourceCandidate[] {
  const byKey = new Map<string, ScriptResourceCandidate>();

  for (const resource of resources) {
    const key = `${resource.type}|${resource.reference.toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, resource);
      continue;
    }

    if (resource.existsOnDisk && !existing.existsOnDisk) {
      byKey.set(key, resource);
      continue;
    }

    if (!existing.resolvedPath && resource.resolvedPath) {
      byKey.set(key, resource);
    }
  }

  return Array.from(byKey.values()).sort((a, b) => a.reference.localeCompare(b.reference));
}

function mapPersistedResourceType(value: string): ScriptResourceType {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'java_config' || normalized === 'json' || normalized === 'attachment') {
    return normalized;
  }
  return 'data_file';
}

function toSafeMetadataObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function isUndefinedTableError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: string }).code === '42P01';
}

async function persistScriptResourceSnapshot(scriptId: number, resources: ScriptResourceCandidate[]): Promise<void> {
  await execute(
    `DELETE FROM script_configuration_resources
     WHERE script_id = $1 AND source_kind = 'parser'`,
    [scriptId]
  );

  for (const resource of resources) {
    await execute(
      `INSERT INTO script_configuration_resources
        (script_id, resource_type, reference_value, resolved_path, exists_on_disk, source_kind, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (script_id, resource_type, reference_value)
       DO UPDATE SET
         resolved_path = EXCLUDED.resolved_path,
         exists_on_disk = EXCLUDED.exists_on_disk,
         source_kind = EXCLUDED.source_kind,
         metadata = EXCLUDED.metadata,
         updated_at = CURRENT_TIMESTAMP`,
      [
        scriptId,
        resource.type,
        resource.reference,
        resource.resolvedPath,
        resource.existsOnDisk,
        resource.sourceKind,
        JSON.stringify(resource.metadata || {}),
      ]
    );
  }
}

function parseJavaSignals(source: string, className: string): {
  packageName: string | null;
  imports: string[];
  annotations: string[];
  methods: string[];
  previewLines: string[];
  lineCount: number;
} {
  const sanitizedSource = stripJavaComments(source);
  const metadata = extractJavaScriptMetadata(source, `${getSimpleClassName(className) || 'Script'}.java`);
  const imports = Array.from(
    new Set(
      Array.from(sanitizedSource.matchAll(/^\s*import\s+(?:static\s+)?([^\s;]+)\s*;/gm))
        .map(match => (match[1] || '').trim())
        .filter(Boolean)
    )
  ).slice(0, 60);

  const annotations = Array.from(
    new Set(
      Array.from(sanitizedSource.matchAll(/@\s*([A-Za-z_][\w.]*)/g))
        .map(match => (match[1] || '').trim())
        .filter(Boolean)
    )
  ).slice(0, 40);

  const simpleClassName = getSimpleClassName(className);
  const methods = Array.from(
    new Set(
      Array.from(
        sanitizedSource.matchAll(
          /^\s*(?:(?:public|protected|private|static|final|synchronized|abstract|native|default)\s+)*(?:<[^>]+>\s*)?[\w$<>\[\], ?]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*(?:throws\s+[^{]+)?\{/gm
        )
      )
        .map(match => (match[1] || '').trim())
        .filter(name => !!name && name !== simpleClassName)
    )
  ).slice(0, 60);

  const sourceLines = source.split(/\r?\n/);
  const previewLines = sourceLines.slice(0, 80).map((line, index) => `${index + 1}  ${line}`);

  return {
    packageName: metadata.packageName,
    imports,
    annotations,
    methods,
    previewLines,
    lineCount: sourceLines.length,
  };
}

function getImportSimpleName(importReference: string): string {
  const cleaned = (importReference || '').replace(/^\s*static\s+/i, '').trim();
  if (!cleaned) return '';
  const parts = cleaned.split('.');
  return parts[parts.length - 1] || cleaned;
}

function normalizeIdentifierToken(value: string): string {
  return (value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function applyLogicalName(resource: ScriptResourceCandidate, logicalName: string): ScriptResourceCandidate {
  return {
    ...resource,
    metadata: {
      ...toSafeMetadataObject(resource.metadata),
      logicalName,
    },
  };
}

function resolveJavaConfigResourceByImport(
  importReference: string,
  mergedResources: ScriptResourceCandidate[],
  sourceRoots: SyncSourceRoot[]
): ScriptResourceCandidate | null {
  const normalizedImport = (importReference || '').trim().toLowerCase();
  if (!normalizedImport) {
    return null;
  }

  const fromMerged = mergedResources.find(resource =>
    resource.type === 'java_config'
    && !!resource.resolvedPath
    && resource.existsOnDisk
    && (resource.reference || '').trim().toLowerCase() === normalizedImport
  );
  if (fromMerged) {
    return fromMerged;
  }

  const resolved = resolveJavaImportSourcePath(importReference, sourceRoots);
  if (!resolved.existsOnDisk || !resolved.resolvedPath) {
    return null;
  }

  return {
    type: 'java_config',
    reference: importReference,
    resolvedPath: resolved.resolvedPath,
    existsOnDisk: true,
    sourceKind: 'parser',
    metadata: {
      detectedFrom: 'script_import',
      importReference,
    },
  };
}

function findPrimaryScriptConfigImport(scriptClassName: string, imports: string[]): string | null {
  if (!imports.length) {
    return null;
  }

  const normalizedScriptToken = normalizeIdentifierToken(getSimpleClassName(scriptClassName))
    .replace(/(e2e|test|script|screen|case)+/g, '');

  let bestImport: string | null = null;
  let bestScore = -1;

  for (const importReference of imports) {
    const simpleName = getImportSimpleName(importReference);
    const normalizedSimple = normalizeIdentifierToken(simpleName);
    const lowerImport = (importReference || '').toLowerCase();

    if (!normalizedSimple.includes('config')) continue;
    if (normalizedSimple === 'baseconfig') continue;
    if (normalizedSimple === 'htmlpath') continue;
    if (normalizedSimple.includes('commonconfig')) continue;

    let score = 0;
    if (normalizedScriptToken && normalizedSimple.includes(normalizedScriptToken)) score += 8;
    if (normalizedSimple.endsWith('config')) score += 2;
    if (lowerImport.includes('.config.')) score += 2;

    if (score > bestScore) {
      bestImport = importReference;
      bestScore = score;
    }
  }

  return bestImport;
}

function extractPrimaryJsonReferenceFromJavaConfigSource(source: string): string | null {
  const constantPattern = /\bCONFIG_FILE\b\s*=\s*"([^"]+\.json)"/i;
  const constantMatch = source.match(constantPattern);
  if (constantMatch?.[1]) {
    const normalized = normalizeResourceReference(constantMatch[1]);
    if (normalized) return normalized;
  }

  const loadPattern = /loadConfiguration\s*\((?:[^()"']|"[^"]*"|'[^']*')*?"([^"]+\.json)"/i;
  const loadMatch = source.match(loadPattern);
  if (loadMatch?.[1]) {
    const normalized = normalizeResourceReference(loadMatch[1]);
    if (normalized) return normalized;
  }

  const literalCandidates = extractJavaStringLiterals(source)
    .map(value => normalizeResourceReference(value))
    .filter(value => value && value.toLowerCase().endsWith('.json'));
  return literalCandidates.length > 0 ? literalCandidates[0] : null;
}

function pickFallbackPrimaryJsonResource(
  scriptClassName: string,
  jsonResources: ScriptResourceCandidate[]
): ScriptResourceCandidate | null {
  if (!jsonResources.length) {
    return null;
  }

  const normalizedScriptToken = normalizeIdentifierToken(getSimpleClassName(scriptClassName))
    .replace(/(e2e|test|script|screen|case)+/g, '');
  let best: ScriptResourceCandidate | null = null;
  let bestScore = -1;

  for (const resource of jsonResources) {
    const reference = (resource.reference || '').toLowerCase();
    const normalizedRef = normalizeIdentifierToken(reference);
    let score = 0;
    if (resource.existsOnDisk) score += 3;
    if (normalizedScriptToken && normalizedRef.includes(normalizedScriptToken)) score += 8;
    if (reference.includes('/config/') || reference.includes('configuration')) score += 2;

    if (score > bestScore) {
      best = resource;
      bestScore = score;
    }
  }

  return best;
}

function buildFocusedScriptConfigurationResources(params: {
  script: ScriptDetailsRow;
  sourceRoots: SyncSourceRoot[];
  javaSignals: {
    packageName: string | null;
    imports: string[];
    annotations: string[];
    methods: string[];
    previewLines: string[];
    lineCount: number;
  };
  mergedResources: ScriptResourceCandidate[];
}): {
  javaConfigResources: ScriptResourceCandidate[];
  jsonResources: ScriptResourceCandidate[];
  attachmentResources: ScriptResourceCandidate[];
  dataFileResources: ScriptResourceCandidate[];
  allEditableResourceCandidates: ScriptResourceCandidate[];
} {
  const imports = params.javaSignals.imports || [];
  const selectedJavaResources: ScriptResourceCandidate[] = [];
  const seenJava = new Set<string>();

  const addJavaResource = (resource: ScriptResourceCandidate | null, logicalName: string) => {
    if (!resource || !resource.resolvedPath) return;
    const key = normalizeAbsolutePathForCompare(resource.resolvedPath);
    if (seenJava.has(key)) return;
    seenJava.add(key);
    selectedJavaResources.push(applyLogicalName(resource, logicalName));
  };

  const primaryImport = findPrimaryScriptConfigImport(params.script.class_name, imports);
  const htmlPathImport = imports.find(value => getImportSimpleName(value).toLowerCase() === 'htmlpath') || null;
  const baseConfigImport = imports.find(value => getImportSimpleName(value).toLowerCase() === 'baseconfig') || null;
  const commonConfigImport = imports.find(value => {
    const normalized = normalizeIdentifierToken(getImportSimpleName(value));
    return normalized.includes('commonconfig')
      || normalized.includes('commonconfiguration')
      || normalized.includes('comkonconfig');
  }) || null;

  addJavaResource(
    primaryImport
      ? resolveJavaConfigResourceByImport(primaryImport, params.mergedResources, params.sourceRoots)
      : null,
    'Script Config Class'
  );
  addJavaResource(
    htmlPathImport
      ? resolveJavaConfigResourceByImport(htmlPathImport, params.mergedResources, params.sourceRoots)
      : null,
    'HTML Path Locators'
  );
  addJavaResource(
    baseConfigImport
      ? resolveJavaConfigResourceByImport(baseConfigImport, params.mergedResources, params.sourceRoots)
      : null,
    'Base Configuration'
  );
  addJavaResource(
    commonConfigImport
      ? resolveJavaConfigResourceByImport(commonConfigImport, params.mergedResources, params.sourceRoots)
      : null,
    'Common Configuration'
  );

  if (selectedJavaResources.length === 0) {
    const fallbackJava = params.mergedResources.filter(resource =>
      resource.type === 'java_config'
      && resource.existsOnDisk
      && !!resource.resolvedPath
      && resolveEditableFileType(resource.resolvedPath || '') === 'java'
    ).slice(0, 4);

    for (const fallback of fallbackJava) {
      addJavaResource(fallback, 'Java Configuration');
    }
  }

  const primaryJavaResource = selectedJavaResources.find(resource => {
    const simpleName = normalizeIdentifierToken(getImportSimpleName(resource.reference));
    return simpleName.endsWith('config')
      && simpleName !== 'baseconfig'
      && simpleName !== 'htmlpath'
      && !simpleName.includes('commonconfig');
  }) || selectedJavaResources[0] || null;

  let primaryJsonResource: ScriptResourceCandidate | null = null;
  if (primaryJavaResource?.resolvedPath && fs.existsSync(primaryJavaResource.resolvedPath)) {
    try {
      const javaConfigSource = fs.readFileSync(primaryJavaResource.resolvedPath, 'utf8');
      const jsonReference = extractPrimaryJsonReferenceFromJavaConfigSource(javaConfigSource);
      if (jsonReference) {
        const resolvedJson = resolveResourceReferencePath(jsonReference, {
          scriptAbsolutePath: primaryJavaResource.resolvedPath,
          sourceRoots: params.sourceRoots,
        });
        primaryJsonResource = {
          type: 'json',
          reference: jsonReference,
          resolvedPath: resolvedJson.resolvedPath,
          existsOnDisk: resolvedJson.existsOnDisk,
          sourceKind: 'parser',
          metadata: {
            detectedFrom: 'primary_config_java',
            logicalName: 'Script Configuration JSON',
            parentConfigReference: primaryJavaResource.reference,
          },
        };
      }
    } catch {
      // Ignore read failure and fallback to merged resources.
    }
  }

  if (!primaryJsonResource) {
    const fallbackJson = pickFallbackPrimaryJsonResource(
      params.script.class_name,
      params.mergedResources.filter(resource => resource.type === 'json')
    );
    if (fallbackJson) {
      primaryJsonResource = applyLogicalName(fallbackJson, 'Script Configuration JSON');
    }
  } else {
    primaryJsonResource = applyLogicalName(primaryJsonResource, 'Script Configuration JSON');
  }

  const jsonResources = primaryJsonResource ? [primaryJsonResource] : [];

  const attachmentResourcesRaw: ScriptResourceCandidate[] = [];
  const dataFileResourcesRaw: ScriptResourceCandidate[] = [];

  if (primaryJsonResource?.resolvedPath && primaryJsonResource.existsOnDisk && fs.existsSync(primaryJsonResource.resolvedPath)) {
    try {
      const parsedJson = JSON.parse(fs.readFileSync(primaryJsonResource.resolvedPath, 'utf8'));
      const literalValues = new Set<string>();
      collectJsonStringLiterals(parsedJson, literalValues);

      for (const literal of literalValues) {
        const resourceType = classifyReferencedResource(literal);
        if (resourceType !== 'attachment' && resourceType !== 'data_file') {
          continue;
        }

        const normalizedReference = normalizeResourceReference(literal);
        if (!normalizedReference) {
          continue;
        }

        const resolved = resolveResourceReferencePath(normalizedReference, {
          scriptAbsolutePath: primaryJsonResource.resolvedPath,
          sourceRoots: params.sourceRoots,
        });

        const candidate: ScriptResourceCandidate = {
          type: resourceType,
          reference: normalizedReference,
          resolvedPath: resolved.resolvedPath,
          existsOnDisk: resolved.existsOnDisk,
          sourceKind: 'parser',
          metadata: {
            detectedFrom: 'primary_script_json',
            parentJsonFile: path.basename(primaryJsonResource.resolvedPath),
          },
        };

        if (resourceType === 'attachment') {
          attachmentResourcesRaw.push(candidate);
        } else {
          dataFileResourcesRaw.push(candidate);
        }
      }
    } catch {
      // Ignore malformed JSON while building dependency hints.
    }
  }

  const attachmentResources = dedupeScriptResourceCandidates(attachmentResourcesRaw)
    .filter(resource => resource.existsOnDisk && !!resource.resolvedPath)
    .map(resource => applyLogicalName(resource, 'Attachment'));
  const dataFileResources = dedupeScriptResourceCandidates(dataFileResourcesRaw)
    .map(resource => applyLogicalName(resource, 'Data File'));

  const javaConfigResources = dedupeScriptResourceCandidates([
    ...selectedJavaResources,
    ...jsonResources,
  ]);

  return {
    javaConfigResources,
    jsonResources,
    attachmentResources,
    dataFileResources,
    allEditableResourceCandidates: dedupeScriptResourceCandidates([
      ...javaConfigResources,
      ...jsonResources,
    ]),
  };
}

async function getScriptDetailsById(scriptId: number): Promise<ScriptDetailsRow | null> {
  const rows = await query<ScriptDetailsRow>(`
    SELECT
      s.*,
      sc.name as category_name,
      sc.icon as category_icon,
      sc.color as category_color,
      u.full_name as created_by_name
    FROM scripts s
    JOIN script_categories sc ON s.category_id = sc.id
    LEFT JOIN users u ON u.id = s.created_by
    WHERE s.id = $1
    LIMIT 1
  `, [scriptId]);

  return rows.length > 0 ? rows[0] : null;
}

async function collectScriptResourceContext(script: ScriptDetailsRow, persistSnapshot = true): Promise<{
  scriptLocation: ResolvedScriptLocation;
  resolvedScriptPath: string | null;
  bestEffortScriptPath: string | null;
  javaSource: string;
  javaFileSizeBytes: number;
  javaLastModifiedAt: Date | null;
  sourceReadError: string | null;
  javaSignals: {
    packageName: string | null;
    imports: string[];
    annotations: string[];
    methods: string[];
    previewLines: string[];
    lineCount: number;
  };
  mergedResources: ScriptResourceCandidate[];
}> {
  const scriptLocation = await resolveScriptLocation(script.file_path);
  const resolvedScriptPath = scriptLocation.absolutePath;
  const bestEffortScriptPath = scriptLocation.bestEffortPath;

  let javaSource = '';
  let javaFileSizeBytes = 0;
  let javaLastModifiedAt: Date | null = null;
  let sourceReadError: string | null = null;
  let javaSignals = {
    packageName: null as string | null,
    imports: [] as string[],
    annotations: [] as string[],
    methods: [] as string[],
    previewLines: [] as string[],
    lineCount: 0,
  };

  let parsedResources: ScriptResourceCandidate[] = [];

  if (resolvedScriptPath && fs.existsSync(resolvedScriptPath)) {
    javaSource = fs.readFileSync(resolvedScriptPath, 'utf8');
    const stats = fs.statSync(resolvedScriptPath);
    javaFileSizeBytes = Number(stats.size || 0);
    javaLastModifiedAt = stats.mtime ?? null;

    javaSignals = parseJavaSignals(javaSource, script.class_name);
    parsedResources = dedupeScriptResourceCandidates([
      ...buildJavaImportConfigurationCandidates(javaSignals.imports, {
        sourceRoots: scriptLocation.sourceRoots,
      }),
      ...buildSourceResourceCandidates(javaSource, {
        scriptAbsolutePath: resolvedScriptPath,
        sourceRoots: scriptLocation.sourceRoots,
      }),
    ]);

    const linkedJavaResources = buildLinkedJavaConfigResourceCandidates(parsedResources, {
      sourceRoots: scriptLocation.sourceRoots,
    });
    const jsonDerivedResources = buildJsonDerivedResourceCandidates([
      ...parsedResources,
      ...linkedJavaResources,
    ], {
      sourceRoots: scriptLocation.sourceRoots,
    });

    parsedResources = dedupeScriptResourceCandidates([
      ...parsedResources,
      ...linkedJavaResources,
      ...jsonDerivedResources,
    ]);

    if (persistSnapshot) {
      try {
        await persistScriptResourceSnapshot(script.id, parsedResources);
      } catch (persistError) {
        if (!isUndefinedTableError(persistError)) {
          throw persistError;
        }
        logger.warn('script_configuration_resources table not found while persisting snapshot.');
      }
    }

    if (persistSnapshot) {
      const primaryJavaConfig = parsedResources.find(resource => resource.type === 'java_config');
      if (primaryJavaConfig && primaryJavaConfig.reference) {
        await execute('UPDATE scripts SET config_file = $1 WHERE id = $2', [primaryJavaConfig.reference, script.id]);
      }
    }
  } else {
    sourceReadError = `Script file is not available on disk for path "${script.file_path}".`;
  }

  let persistedRows: ScriptConfigurationResourceRecordRow[] = [];
  try {
    persistedRows = await query<ScriptConfigurationResourceRecordRow>(`
      SELECT resource_type, reference_value, resolved_path, exists_on_disk, source_kind, metadata, updated_at
      FROM script_configuration_resources
      WHERE script_id = $1
      ORDER BY resource_type, reference_value
    `, [script.id]);
  } catch (persistedReadError) {
    if (!isUndefinedTableError(persistedReadError)) {
      throw persistedReadError;
    }
    logger.warn('script_configuration_resources table not found while reading snapshot.');
  }

  const persistedResources: ScriptResourceCandidate[] = persistedRows.map(row => ({
    type: mapPersistedResourceType(row.resource_type),
    reference: row.reference_value,
    resolvedPath: formatPathForResponse(row.resolved_path),
    existsOnDisk: !!row.exists_on_disk,
    sourceKind: row.source_kind === 'parser' ? 'parser' : 'persisted',
    metadata: {
      ...toSafeMetadataObject(row.metadata),
      persistedUpdatedAt: row.updated_at,
    },
  }));

  const mergedResources = dedupeScriptResourceCandidates([
    ...persistedResources,
    ...parsedResources,
  ]);

  return {
    scriptLocation,
    resolvedScriptPath,
    bestEffortScriptPath,
    javaSource,
    javaFileSizeBytes,
    javaLastModifiedAt,
    sourceReadError,
    javaSignals,
    mergedResources,
  };
}

function normalizeAbsolutePathForCompare(value: string): string {
  return path.resolve(value).replace(/\\/g, '/').toLowerCase();
}

function resolveEditableFileType(filePath: string): 'java' | 'json' | null {
  const extension = path.extname((filePath || '').toLowerCase());
  if (extension === '.java') return 'java';
  if (extension === '.json') return 'json';
  return null;
}

function buildEditableConfigFiles(resources: ScriptResourceCandidate[]): EditableScriptConfigFile[] {
  const filesByPath = new Map<string, EditableScriptConfigFile>();

  for (const resource of resources) {
    if (resource.type !== 'java_config' && resource.type !== 'json') {
      continue;
    }
    if (!resource.existsOnDisk || !resource.resolvedPath) {
      continue;
    }

    const fileType = resolveEditableFileType(resource.resolvedPath);
    if (!fileType) {
      continue;
    }

    const normalizedPath = normalizeAbsolutePathForCompare(resource.resolvedPath);
    if (filesByPath.has(normalizedPath)) {
      continue;
    }

    let fileSizeBytes: number | null = null;
    let lastModifiedAt: Date | null = null;

    try {
      const stats = fs.statSync(resource.resolvedPath);
      fileSizeBytes = Number(stats.size || 0);
      lastModifiedAt = stats.mtime ?? null;
    } catch {
      // Keep null file metadata when stat fails.
    }

    filesByPath.set(normalizedPath, {
      path: resource.resolvedPath,
      fileType,
      reference: resource.reference,
      sourceType: resource.type,
      existsOnDisk: resource.existsOnDisk,
      fileSizeBytes,
      lastModifiedAt,
    });
  }

  return Array.from(filesByPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function hashContent(value: string): string {
  return createHash('sha256').update(value || '', 'utf8').digest('hex');
}

function summarizeTextChange(previousContent: string, nextContent: string): Record<string, unknown> {
  const beforeLines = previousContent.split(/\r?\n/);
  const afterLines = nextContent.split(/\r?\n/);
  const maxLength = Math.max(beforeLines.length, afterLines.length);
  const changePreview: Array<{ line: number; before: string; after: string }> = [];
  let changedLines = 0;

  for (let index = 0; index < maxLength; index += 1) {
    const before = beforeLines[index] ?? '';
    const after = afterLines[index] ?? '';
    if (before === after) {
      continue;
    }

    changedLines += 1;
    if (changePreview.length < 40) {
      changePreview.push({
        line: index + 1,
        before: before.slice(0, 300),
        after: after.slice(0, 300),
      });
    }
  }

  return {
    changedLines,
    beforeLineCount: beforeLines.length,
    afterLineCount: afterLines.length,
    preview: changePreview,
    beforeHash: hashContent(previousContent),
    afterHash: hashContent(nextContent),
  };
}

async function readScriptConfigChangeHistory(scriptId: number, limit: number): Promise<Array<{
  id: number;
  scriptId: number;
  filePath: string;
  fileName: string;
  fileType: string;
  changedBy: string;
  changedAt: Date;
  changeSummary: Record<string, unknown>;
}>> {
  try {
    const rows = await query<ScriptConfigChangeLogRow>(`
      SELECT
        scl.id,
        scl.script_id,
        scl.file_path,
        scl.file_type,
        scl.previous_content,
        scl.updated_content,
        scl.change_summary,
        scl.changed_by,
        scl.changed_at,
        COALESCE(u.full_name, u.username, 'System') AS changed_by_name
      FROM script_configuration_change_logs scl
      LEFT JOIN users u ON u.id = scl.changed_by
      WHERE scl.script_id = $1
      ORDER BY scl.changed_at DESC
      LIMIT $2
    `, [scriptId, limit]);

    return rows.map(row => ({
      id: row.id,
      scriptId: row.script_id,
      filePath: row.file_path,
      fileName: path.basename(row.file_path || ''),
      fileType: row.file_type,
      changedBy: row.changed_by_name || 'System',
      changedAt: row.changed_at,
      changeSummary: toSafeMetadataObject(row.change_summary),
    }));
  } catch (error) {
    if (!isUndefinedTableError(error)) {
      throw error;
    }
    return [];
  }
}

// GET /api/scripts - List all scripts with filtering
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { category, search, active } = req.query;
    let sql = `
      SELECT s.*, sc.name as category_name, sc.icon as category_icon, sc.color as category_color,
        lr.last_run_at, lr.last_run_status
      FROM scripts s
      JOIN script_categories sc ON s.category_id = sc.id
      LEFT JOIN LATERAL (
        SELECT er.started_at AS last_run_at, er.status AS last_run_status
        FROM execution_results eres
        JOIN execution_runs er ON eres.run_id = er.id
        WHERE eres.script_id = s.id
        ORDER BY er.started_at DESC NULLS LAST
        LIMIT 1
      ) lr ON TRUE
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

    const scripts = await query<ScriptRow & { last_run_at?: Date; last_run_status?: string }>(sql, params);
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
      lastRunAt: s.last_run_at || null,
      lastRunStatus: s.last_run_status || null,
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

// GET /api/scripts/:id/configuration - Get enriched script configuration details
router.get('/:id/configuration', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scriptId = Number(req.params.id);
    if (!Number.isInteger(scriptId) || scriptId <= 0) {
      res.status(400).json({ error: 'Invalid script ID.' });
      return;
    }

    const script = await getScriptDetailsById(scriptId);
    if (!script) {
      res.status(404).json({ error: 'Script not found.' });
      return;
    }

    const resourceContext = await collectScriptResourceContext(script, true);
    const focusedResources = buildFocusedScriptConfigurationResources({
      script,
      sourceRoots: resourceContext.scriptLocation.sourceRoots,
      javaSignals: resourceContext.javaSignals,
      mergedResources: resourceContext.mergedResources,
    });
    const {
      javaConfigResources,
      jsonResources,
      attachmentResources,
      dataFileResources,
      allEditableResourceCandidates,
    } = focusedResources;

    const summaryRows = await query<ScriptExecutionSummaryRow>(`
      SELECT
        COUNT(*)::int AS total_runs,
        COUNT(*) FILTER (WHERE eres.status = 'passed')::int AS passed_runs,
        COUNT(*) FILTER (WHERE eres.status = 'failed')::int AS failed_runs,
        COUNT(*) FILTER (WHERE eres.status = 'error')::int AS error_runs,
        COUNT(*) FILTER (WHERE eres.status = 'skipped')::int AS skipped_runs,
        ROUND(AVG(NULLIF(eres.duration_ms, 0)))::bigint AS average_script_duration_ms,
        COUNT(DISTINCT er.triggered_by)::int AS unique_executors
      FROM execution_results eres
      JOIN execution_runs er ON er.id = eres.run_id
      WHERE eres.script_id = $1
    `, [scriptId]);
    const summary = summaryRows[0] || {
      total_runs: 0,
      passed_runs: 0,
      failed_runs: 0,
      error_runs: 0,
      skipped_runs: 0,
      average_script_duration_ms: null,
      unique_executors: 0,
    };

    const recentRuns = await query<ScriptRunHistoryRow>(`
      SELECT
        er.id as run_id,
        er.run_name,
        er.status as run_status,
        eres.status as result_status,
        er.environment,
        er.started_at,
        er.completed_at,
        er.duration_ms as run_duration_ms,
        eres.duration_ms as script_duration_ms,
        COALESCE(u.full_name, u.username, 'System') as triggered_by_name
      FROM execution_results eres
      JOIN execution_runs er ON er.id = eres.run_id
      LEFT JOIN users u ON u.id = er.triggered_by
      WHERE eres.script_id = $1
      ORDER BY er.started_at DESC NULLS LAST, er.created_at DESC
      LIMIT 15
    `, [scriptId]);

    const artifactRows = await query<ScriptArtifactRow>(`
      SELECT
        ea.id,
        ea.run_id,
        ea.artifact_type,
        ea.file_name,
        ea.stored_path,
        ea.file_size_bytes,
        ea.mime_type,
        ea.created_at,
        er.run_name,
        er.status as run_status,
        er.started_at as run_started_at
      FROM execution_artifacts ea
      LEFT JOIN execution_runs er ON er.id = ea.run_id
      WHERE ea.script_id = $1
      ORDER BY ea.created_at DESC
      LIMIT 30
    `, [scriptId]);

    const totalRuns = Number(summary.total_runs || 0);
    const passedRuns = Number(summary.passed_runs || 0);
    const failedRuns = Number(summary.failed_runs || 0);
    const errorRuns = Number(summary.error_runs || 0);
    const skippedRuns = Number(summary.skipped_runs || 0);
    const passRate = totalRuns > 0 ? Math.round((passedRuns / totalRuns) * 100) : 0;
    const stabilityScore = totalRuns > 0
      ? Math.max(0, Math.min(100, Math.round(((passedRuns + (skippedRuns * 0.25)) / totalRuns) * 100)))
      : 0;

    const mappedRuns = recentRuns.map(run => ({
      runId: run.run_id,
      runName: run.run_name,
      runStatus: run.run_status,
      scriptStatus: run.result_status,
      environment: run.environment,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      runDurationMs: run.run_duration_ms,
      scriptDurationMs: run.script_duration_ms,
      triggeredBy: run.triggered_by_name || 'System',
    }));

    const lastRun = mappedRuns.length > 0 ? mappedRuns[0] : null;
    const editableFiles = buildEditableConfigFiles(allEditableResourceCandidates);
    const recentFileChanges = await readScriptConfigChangeHistory(scriptId, 25);

    res.json({
      script: {
        id: script.id,
        name: (script.name || '').replace(/\.java$/i, ''),
        className: script.class_name,
        methodName: script.method_name,
        categoryId: script.category_id,
        categoryName: script.category_name,
        categoryIcon: script.category_icon,
        categoryColor: script.category_color,
        description: script.description,
        filePath: script.file_path,
        resolvedFilePath: formatPathForResponse(resourceContext.resolvedScriptPath || resourceContext.bestEffortScriptPath),
        configFile: script.config_file,
        isActive: script.is_active,
        tags: script.tags || [],
        createdAt: script.created_at,
        updatedAt: script.updated_at,
        createdBy: script.created_by_name || null,
      },
      java: {
        packageName: resourceContext.javaSignals.packageName,
        imports: resourceContext.javaSignals.imports,
        annotations: resourceContext.javaSignals.annotations,
        methods: resourceContext.javaSignals.methods,
        previewLines: resourceContext.javaSignals.previewLines,
        lineCount: resourceContext.javaSignals.lineCount,
        fileSizeBytes: resourceContext.javaFileSizeBytes,
        lastModifiedAt: resourceContext.javaLastModifiedAt,
        sourceAvailable: !!resourceContext.javaSource,
        sourceReadError: resourceContext.sourceReadError,
      },
      resources: {
        javaConfigs: javaConfigResources,
        jsonFiles: [],
        attachments: attachmentResources,
        dataFiles: dataFileResources,
      },
      editableFiles,
      execution: {
        totalRuns,
        passedRuns,
        failedRuns,
        errorRuns,
        skippedRuns,
        passRate,
        stabilityScore,
        uniqueExecutors: Number(summary.unique_executors || 0),
        averageScriptDurationMs: summary.average_script_duration_ms === null
          ? null
          : Number(summary.average_script_duration_ms),
        lastRun,
        recentRuns: mappedRuns,
      },
      artifacts: artifactRows.map(artifact => ({
        id: artifact.id,
        runId: artifact.run_id,
        artifactType: artifact.artifact_type,
        fileName: artifact.file_name,
        storedPath: formatPathForResponse(artifact.stored_path),
        fileSizeBytes: artifact.file_size_bytes,
        mimeType: artifact.mime_type,
        createdAt: artifact.created_at,
        runName: artifact.run_name,
        runStatus: artifact.run_status,
        runStartedAt: artifact.run_started_at,
      })),
      recentFileChanges,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Get script configuration error:', error);
    res.status(500).json({ error: 'Failed to fetch script configuration.' });
  }
});

// GET /api/scripts/:id/configuration/file-content - Read editable config file content
router.get('/:id/configuration/file-content', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scriptId = Number(req.params.id);
    const requestedPath = String(req.query.path || '').trim();
    if (!Number.isInteger(scriptId) || scriptId <= 0) {
      res.status(400).json({ error: 'Invalid script ID.' });
      return;
    }
    if (!requestedPath) {
      res.status(400).json({ error: 'File path is required.' });
      return;
    }

    const script = await getScriptDetailsById(scriptId);
    if (!script) {
      res.status(404).json({ error: 'Script not found.' });
      return;
    }

    const resourceContext = await collectScriptResourceContext(script, false);
    const focusedResources = buildFocusedScriptConfigurationResources({
      script,
      sourceRoots: resourceContext.scriptLocation.sourceRoots,
      javaSignals: resourceContext.javaSignals,
      mergedResources: resourceContext.mergedResources,
    });
    const editableFiles = buildEditableConfigFiles(focusedResources.allEditableResourceCandidates);
    const normalizedRequestedPath = normalizeAbsolutePathForCompare(requestedPath);
    const selectedFile = editableFiles.find(file =>
      normalizeAbsolutePathForCompare(file.path) === normalizedRequestedPath
    );

    if (!selectedFile) {
      res.status(404).json({ error: 'Requested file is not linked to this script configuration.' });
      return;
    }

    if (!fs.existsSync(selectedFile.path)) {
      res.status(404).json({ error: 'Configuration file not found on disk.' });
      return;
    }

    const content = fs.readFileSync(selectedFile.path, 'utf8');
    const stats = fs.statSync(selectedFile.path);
    res.json({
      path: selectedFile.path,
      fileName: path.basename(selectedFile.path),
      fileType: selectedFile.fileType,
      reference: selectedFile.reference,
      fileSizeBytes: Number(stats.size || 0),
      lastModifiedAt: stats.mtime ?? null,
      content,
    });
  } catch (error) {
    logger.error('Get script configuration file content error:', error);
    res.status(500).json({ error: 'Failed to load configuration file.' });
  }
});

// PUT /api/scripts/:id/configuration/file - Update editable config file
router.put('/:id/configuration/file', authorize('admin', 'tester'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scriptId = Number(req.params.id);
    const requestedPath = String(req.body?.path || '').trim();
    const hasStringContent = typeof req.body?.content === 'string';
    const nextContent = hasStringContent ? req.body.content : '';

    if (!Number.isInteger(scriptId) || scriptId <= 0) {
      res.status(400).json({ error: 'Invalid script ID.' });
      return;
    }
    if (!requestedPath) {
      res.status(400).json({ error: 'File path is required.' });
      return;
    }
    if (!hasStringContent) {
      res.status(400).json({ error: 'File content must be provided as text.' });
      return;
    }
    if (nextContent.length > 2_000_000) {
      res.status(413).json({ error: 'Configuration file is too large to update from UI.' });
      return;
    }

    const script = await getScriptDetailsById(scriptId);
    if (!script) {
      res.status(404).json({ error: 'Script not found.' });
      return;
    }

    const resourceContext = await collectScriptResourceContext(script, false);
    const focusedResources = buildFocusedScriptConfigurationResources({
      script,
      sourceRoots: resourceContext.scriptLocation.sourceRoots,
      javaSignals: resourceContext.javaSignals,
      mergedResources: resourceContext.mergedResources,
    });
    const editableFiles = buildEditableConfigFiles(focusedResources.allEditableResourceCandidates);
    const normalizedRequestedPath = normalizeAbsolutePathForCompare(requestedPath);
    const selectedFile = editableFiles.find(file =>
      normalizeAbsolutePathForCompare(file.path) === normalizedRequestedPath
    );

    if (!selectedFile) {
      res.status(404).json({ error: 'Requested file is not editable for this script.' });
      return;
    }
    if (!fs.existsSync(selectedFile.path)) {
      res.status(404).json({ error: 'Configuration file not found on disk.' });
      return;
    }

    const previousContent = fs.readFileSync(selectedFile.path, 'utf8');
    if (previousContent === nextContent) {
      res.json({
        message: 'No changes detected.',
        changed: false,
        file: {
          path: selectedFile.path,
          fileType: selectedFile.fileType,
        },
      });
      return;
    }

    if (selectedFile.fileType === 'json') {
      try {
        JSON.parse(nextContent);
      } catch (jsonError) {
        res.status(400).json({
          error: `Invalid JSON: ${(jsonError as Error).message}`,
        });
        return;
      }
    }

    fs.writeFileSync(selectedFile.path, nextContent, { encoding: 'utf8' });
    const updatedStats = fs.statSync(selectedFile.path);
    const changeSummary = summarizeTextChange(previousContent, nextContent);

    try {
      await execute(
        `INSERT INTO script_configuration_change_logs
          (script_id, file_path, file_type, previous_content, updated_content, change_summary, changed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          scriptId,
          selectedFile.path,
          selectedFile.fileType,
          previousContent,
          nextContent,
          JSON.stringify(changeSummary),
          req.userId || null,
        ]
      );
    } catch (auditError) {
      if (!isUndefinedTableError(auditError)) {
        throw auditError;
      }
    }

    logScriptEvent(req, {
      action: 'SCRIPT_CONFIG_FILE_UPDATE',
      severity: 'INFO',
      status: 'SUCCESS',
      httpStatus: 200,
      message: `Configuration file "${path.basename(selectedFile.path)}" updated for script "${script.name}".`,
      metadata: {
        scriptId,
        scriptName: script.name,
        filePath: selectedFile.path,
        fileType: selectedFile.fileType,
        changedLines: Number(changeSummary.changedLines || 0),
      },
    });

    res.json({
      message: 'Configuration file updated successfully.',
      changed: true,
      file: {
        path: selectedFile.path,
        fileName: path.basename(selectedFile.path),
        fileType: selectedFile.fileType,
        fileSizeBytes: Number(updatedStats.size || 0),
        lastModifiedAt: updatedStats.mtime ?? null,
      },
      changeSummary,
    });
  } catch (error) {
    logger.error('Update script configuration file error:', error);
    res.status(500).json({ error: 'Failed to update configuration file.' });
  }
});

// GET /api/scripts/:id/configuration/changes - Read configuration file change history
router.get('/:id/configuration/changes', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scriptId = Number(req.params.id);
    const limitRaw = Number(req.query.limit || 40);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.trunc(limitRaw))) : 40;

    if (!Number.isInteger(scriptId) || scriptId <= 0) {
      res.status(400).json({ error: 'Invalid script ID.' });
      return;
    }

    const script = await getScriptDetailsById(scriptId);
    if (!script) {
      res.status(404).json({ error: 'Script not found.' });
      return;
    }

    const history = await readScriptConfigChangeHistory(scriptId, limit);
    res.json(history);
  } catch (error) {
    logger.error('Get script configuration change history error:', error);
    res.status(500).json({ error: 'Failed to fetch configuration change history.' });
  }
});

// GET /api/scripts/:id/configuration/attachment - Stream attachment referenced by script JSON
router.get('/:id/configuration/attachment', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scriptId = Number(req.params.id);
    const requestedPath = String(req.query.path || '').trim();
    const modeRaw = String(req.query.mode || 'open').trim().toLowerCase();
    const mode = modeRaw === 'download' ? 'download' : 'open';

    if (!Number.isInteger(scriptId) || scriptId <= 0) {
      res.status(400).json({ error: 'Invalid script ID.' });
      return;
    }
    if (!requestedPath) {
      res.status(400).json({ error: 'Attachment path is required.' });
      return;
    }

    const script = await getScriptDetailsById(scriptId);
    if (!script) {
      res.status(404).json({ error: 'Script not found.' });
      return;
    }

    const resourceContext = await collectScriptResourceContext(script, false);
    const focusedResources = buildFocusedScriptConfigurationResources({
      script,
      sourceRoots: resourceContext.scriptLocation.sourceRoots,
      javaSignals: resourceContext.javaSignals,
      mergedResources: resourceContext.mergedResources,
    });

    const requestedNormalized = normalizeAbsolutePathForCompare(requestedPath);
    const selectedAttachment = focusedResources.attachmentResources.find(resource =>
      resource.existsOnDisk
      && !!resource.resolvedPath
      && normalizeAbsolutePathForCompare(resource.resolvedPath) === requestedNormalized
    );

    if (!selectedAttachment?.resolvedPath) {
      res.status(404).json({ error: 'Attachment is not linked to this script configuration.' });
      return;
    }

    const absolutePath = path.resolve(selectedAttachment.resolvedPath);
    if (!fs.existsSync(absolutePath)) {
      res.status(404).json({ error: 'Attachment not found on disk.' });
      return;
    }

    const fileName = path.basename(absolutePath).replace(/"/g, '');
    res.setHeader('Content-Type', getMimeTypeForFile(absolutePath));
    res.setHeader(
      'Content-Disposition',
      `${mode === 'download' ? 'attachment' : 'inline'}; filename="${fileName}"`
    );
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(absolutePath, (sendError) => {
      if (sendError && !res.headersSent) {
        logger.error('Stream script attachment error:', sendError);
        res.status(500).json({ error: 'Failed to stream attachment.' });
      }
    });
  } catch (error) {
    logger.error('Get script configuration attachment error:', error);
    res.status(500).json({ error: 'Failed to stream script attachment.' });
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
        addedScripts.push(standardName);

        // Increment user scripts_registered statistic
        await execute('UPDATE users SET scripts_registered = scripts_registered + 1 WHERE id = $1', [req.userId]);

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
