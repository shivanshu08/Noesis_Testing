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
