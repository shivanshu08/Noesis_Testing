export interface User {
  id: number;
  username: string;
  email: string;
  fullName: string;
  role: string;
  avatarUrl?: string;
  lastLogin?: string;
  createdAt?: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: User;
}

export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
  fullName: string;
}

export interface Script {
  id: number;
  name: string;
  className: string;
  methodName?: string;
  categoryId: number;
  categoryName: string;
  categoryIcon: string;
  categoryColor: string;
  description?: string;
  filePath: string;
  configFile?: string;
  isActive: boolean;
  tags: string[];
  createdAt: string;
  lastRunAt?: string;
  lastRunStatus?: string;
  dependencies?: number[];
  dependencyCount?: number;
  dependentCount?: number;
}

export interface ScriptCategory {
  id: number;
  name: string;
  description?: string;
  icon: string;
  color: string;
  sortOrder: number;
  scriptCount: number;
}

export interface ScriptConfigurationResource {
  type: 'java_config' | 'json' | 'attachment' | 'data_file' | string;
  reference: string;
  resolvedPath?: string | null;
  existsOnDisk: boolean;
  sourceKind?: 'parser' | 'persisted' | string;
  metadata?: Record<string, unknown>;
}

export interface ScriptConfigurationRun {
  runId: number;
  runName: string;
  runStatus: string;
  scriptStatus: string;
  environment: string;
  startedAt?: string | null;
  completedAt?: string | null;
  runDurationMs?: number | null;
  scriptDurationMs?: number | null;
  triggeredBy?: string | null;
}

export interface ScriptConfigurationEditableFile {
  path: string;
  fileType: 'java' | 'json' | string;
  reference: string;
  sourceType: 'java_config' | 'json' | 'attachment' | 'data_file' | string;
  existsOnDisk: boolean;
  fileSizeBytes?: number | null;
  lastModifiedAt?: string | null;
}

export interface ScriptConfigurationFileContent {
  path: string;
  fileName: string;
  fileType: 'java' | 'json' | string;
  reference?: string;
  fileSizeBytes?: number | null;
  lastModifiedAt?: string | null;
  content: string;
}

export interface ScriptConfigurationChangeLog {
  id: number;
  scriptId: number;
  filePath: string;
  fileName: string;
  fileType: string;
  changedBy: string;
  changedAt: string;
  changeSummary?: {
    changedLines?: number;
    modifiedLines?: number;
    addedLines?: number;
    removedLines?: number;
    beforeLineCount?: number;
    afterLineCount?: number;
    algorithmVersion?: number;
    isApproximate?: boolean;
    primaryChange?: {
      line?: number;
      beforeLine?: number | null;
      afterLine?: number | null;
      before?: string;
      after?: string;
      kind?: 'modified' | 'added' | 'removed' | string;
    };
    preview?: Array<{
      line: number;
      before: string;
      after: string;
      beforeLine?: number | null;
      afterLine?: number | null;
      kind?: 'modified' | 'added' | 'removed' | string;
    }>;
  } | Record<string, unknown>;
}

export interface ScriptConfigurationChangeLogDetail extends ScriptConfigurationChangeLog {
  previousContent: string;
  updatedContent: string;
}

export interface ScriptConfigurationDetail {
  script: {
    id: number;
    name: string;
    className: string;
    methodName?: string | null;
    categoryId: number;
    categoryName: string;
    categoryIcon: string;
    categoryColor: string;
    description?: string | null;
    filePath: string;
    resolvedFilePath?: string | null;
    configFile?: string | null;
    isActive: boolean;
    tags?: string[];
    createdAt: string;
    updatedAt?: string | null;
    createdBy?: string | null;
  };
  java: {
    packageName?: string | null;
    imports: string[];
    annotations: string[];
    methods: string[];
    previewLines: string[];
    lineCount: number;
    fileSizeBytes?: number;
    lastModifiedAt?: string | null;
    sourceAvailable: boolean;
    sourceReadError?: string | null;
  };
  resources: {
    javaConfigs: ScriptConfigurationResource[];
    jsonFiles: ScriptConfigurationResource[];
    attachments: ScriptConfigurationResource[];
    dataFiles: ScriptConfigurationResource[];
  };
  editableFiles?: ScriptConfigurationEditableFile[];
  execution: {
    totalRuns: number;
    passedRuns: number;
    failedRuns: number;
    errorRuns: number;
    skippedRuns: number;
    passRate: number;
    stabilityScore: number;
    uniqueExecutors: number;
    averageScriptDurationMs?: number | null;
    lastRun?: ScriptConfigurationRun | null;
    recentRuns: ScriptConfigurationRun[];
  };
  recentFileChanges?: ScriptConfigurationChangeLog[];
  artifacts: Array<{
    id: number;
    runId: number;
    artifactType: string;
    fileName: string;
    storedPath?: string | null;
    fileSizeBytes?: number | null;
    mimeType?: string | null;
    createdAt?: string | null;
    runName?: string | null;
    runStatus?: string | null;
    runStartedAt?: string | null;
  }>;
  generatedAt?: string;
}

export interface TestSuite {
  id: number;
  name: string;
  description?: string;
  isParallel: boolean;
  threadCount: number;
  tags?: string[];
  createdBy?: string;
  scriptCount?: number;
  scripts?: SuiteScript[];
  lastRunStatus?: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface SuiteScript {
  id: number;
  name: string;
  className: string;
  categoryName: string;
  categoryColor: string;
  executionOrder: number;
}

export interface ExecutionRun {
  id: number;
  runName: string;
  runType: string;
  suiteId?: number;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'stopped';
  totalScripts: number;
  passedCount: number;
  failedCount: number;
  errorCount: number;
  skippedCount: number;
  durationMs?: number;
  environment: string;
  configXml?: string;
  runMetadata?: {
    executionSource?: 'git' | 'local';
    gitRepoUrl?: string | null;
    gitBranch?: string | null;
    appUrl?: string | null;
    workspacePath?: string;
    suiteFilePath?: string;
    suiteFileName?: string;
    mavenCommand?: string;
    reportsDirectory?: string;
    certificateHardeningStatus?: string;
    certificateHardeningMessage?: string;
    startedAt?: string;
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
  };
  triggeredBy?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  results?: ExecutionResult[];
}

export interface ExecutionResult {
  id: number;
  scriptId: number;
  scriptName: string;
  className: string;
  status: string;
  durationMs?: number;
  errorMessage?: string;
  logOutput?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ExecutionLog {
  runId: number;
  level: string;
  message: string;
  timestamp: string;
}

export interface DashboardStats {
  totalScripts: number;
  totalRuns: number;
  recentRuns: number;
  passRate: number;
  runningCount: number;
  recentHistory: { date: string; status: string; count: number }[];
  categoryStats: { name: string; color: string; count: number }[];
}

export interface ScheduledRun {
  id: number;
  name: string;
  suiteId?: number;
  scriptIds?: number[];
  cronExpression: string;
  description?: string;
  isActive: boolean;
  environment: string;
  isOneTime?: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  createdBy?: string;
  createdAt: string;
}

export interface ExecutionArtifact {
  id: number;
  runId: number;
  scriptId?: number;
  artifactType: 'html' | 'pdf' | 'xml' | 'log' | 'other' | string;
  fileName: string;
  fileSizeBytes?: number;
  mimeType?: string;
  createdAt: string;
}
