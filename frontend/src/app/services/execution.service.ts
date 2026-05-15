import { Injectable, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, Subject, catchError, retry, tap, throwError } from 'rxjs';
import { environment } from '../../environments/environment';
import { ExecutionRun, ExecutionLog, DashboardStats, ScheduledRun, ExecutionArtifact } from '../models/interfaces';
import { SessionService } from './session.service';

@Injectable({ providedIn: 'root' })
export class ExecutionService {
  private readonly apiUrl = `${environment.apiUrl}/execution`;
  private runPollHandle: number | null = null;
  private globalPollHandle: number | null = null;
  private lastRunLogId = 0;
  private seenRunLogKeys = new Set<string>();
  private seenGlobalTerminalRunIds = new Set<number>();
  private globalPollInitialized = false;
  private currentRunSessionHoldKey: string | null = null;
  private readonly globalExecutionHoldKey = 'execution-global-active';

  readonly liveLogs = signal<ExecutionLog[]>([]);
  readonly activeRunStatus = signal<string | null>(null);
  readonly artifactsReady = signal<ExecutionArtifact[]>([]);
  
  readonly globalRunUpdates = new Subject<any>();

  constructor(private http: HttpClient, private sessionService: SessionService) {}

  initGlobalSocket(): void {
    if (this.globalPollHandle === null) {
      const poll = () => {
        this.getRuns({ limit: 20 }).subscribe({
          next: (runs) => {
            const hasActiveRun = runs.some(run => this.isSessionProtectedRunStatus(run.status));
            if (hasActiveRun) {
              this.sessionService.holdExecutionTimeout(this.globalExecutionHoldKey);
            } else {
              this.sessionService.releaseExecutionTimeout(this.globalExecutionHoldKey);
            }

            const terminalRuns = runs.filter(run => this.isTerminalRunStatus(run.status));
            if (!this.globalPollInitialized) {
              terminalRuns.forEach(run => this.seenGlobalTerminalRunIds.add(run.id));
              this.globalPollInitialized = true;
              return;
            }
            terminalRuns.forEach(run => {
              if (this.seenGlobalTerminalRunIds.has(run.id)) return;
              this.seenGlobalTerminalRunIds.add(run.id);
              this.globalRunUpdates.next({
                runId: run.id,
                runName: run.runName,
                status: run.status,
              });
            });
          },
          error: () => {},
        });
      };
      poll();
      this.globalPollHandle = window.setInterval(poll, 5000);
    }
  }

  private isTerminalRunStatus(status: string | null | undefined): boolean {
    return ['passed', 'failed', 'error', 'stopped'].includes(String(status || '').toLowerCase());
  }

  private isSessionProtectedRunStatus(status: string | null | undefined): boolean {
    return ['queued', 'running'].includes(String(status || '').toLowerCase());
  }

  runScripts(scriptIds: number[], suiteName?: string, environmentName = 'local'): Observable<{
    runId: number;
    message: string;
    totalScripts: number;
    resolvedScriptIds?: number[];
    autoIncludedDependencyIds?: number[];
  }> {
    const startHoldKey = `execution-start-${Date.now()}`;
    this.sessionService.holdExecutionTimeout(startHoldKey);

    return this.http.post<{
      runId: number;
      message: string;
      totalScripts: number;
      resolvedScriptIds?: number[];
      autoIncludedDependencyIds?: number[];
    }>(`${this.apiUrl}/run`, {
      scriptIds,
      suiteName,
      environment: environmentName,
    }).pipe(
      tap(response => {
        this.sessionService.releaseExecutionTimeout(startHoldKey);
        this.holdRunSession(response.runId);
      }),
      catchError(error => {
        this.sessionService.releaseExecutionTimeout(startHoldKey);
        return throwError(() => error);
      })
    );
  }

  stopRun(runId: number): Observable<any> {
    return this.http.post(`${this.apiUrl}/stop/${runId}`, {});
  }

  pauseRun(runId: number): Observable<any> {
    return this.http.post(`${this.apiUrl}/pause/${runId}`, {});
  }

  resumeRun(runId: number): Observable<any> {
    return this.http.post(`${this.apiUrl}/resume/${runId}`, {});
  }

  rebuildRun(runId: number): Observable<any> {
    return this.http.post(`${this.apiUrl}/rebuild/${runId}`, {});
  }

  getRuns(filters?: { status?: string; limit?: number; offset?: number }): Observable<ExecutionRun[]> {
    let params = new HttpParams();
    if (filters?.status) params = params.set('status', filters.status);
    if (filters?.limit) params = params.set('limit', filters.limit.toString());
    if (filters?.offset) params = params.set('offset', filters.offset.toString());
    return this.http.get<ExecutionRun[]>(`${this.apiUrl}/runs`, { params }).pipe(retry(2));
  }

  getRunDetails(runId: number): Observable<ExecutionRun> {
    return this.http.get<ExecutionRun>(`${this.apiUrl}/runs/${runId}`).pipe(retry(1));
  }

  getStats(): Observable<DashboardStats> {
    return this.http.get<DashboardStats>(`${this.apiUrl}/stats`).pipe(retry(2));
  }

  getLogs(runId: number): Observable<ExecutionLog[]> {
    return this.http.get<ExecutionLog[]>(`${this.apiUrl}/logs/${runId}`);
  }

  getArtifacts(runId: number): Observable<ExecutionArtifact[]> {
    return this.http.get<ExecutionArtifact[]>(`${this.apiUrl}/runs/${runId}/artifacts`);
  }

  getArtifactDownloadUrl(artifactId: number): string {
    return `${this.apiUrl}/artifacts/${artifactId}/download`;
  }

  mailArtifacts(runId: number, data: {
    recipients: string[];
    artifactIds: number[];
    subject?: string;
    message?: string;
  }): Observable<{ message: string; artifactCount: number; recipientCount: number }> {
    return this.http.post<{ message: string; artifactCount: number; recipientCount: number }>(
      `${this.apiUrl}/runs/${runId}/artifacts/mail`,
      data
    );
  }

  downloadArtifactBlob(artifactId: number, fileName: string): void {
    this.http.get(`${this.apiUrl}/artifacts/${artifactId}/download`, { responseType: 'blob' }).subscribe({
      next: (blob) => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
      },
      error: (err) => console.error('Artifact download failed', err),
    });
  }

  // ---- Schedule Methods ----

  createSchedule(data: {
    name: string;
    scriptIds?: number[];
    suiteId?: number;
    cronExpression: string;
    environment?: string;
    description?: string;
    isOneTime?: boolean;
  }): Observable<ScheduledRun> {
    return this.http.post<ScheduledRun>(`${this.apiUrl}/schedule`, data);
  }

  getSchedules(): Observable<ScheduledRun[]> {
    return this.http.get<ScheduledRun[]>(`${this.apiUrl}/schedules`).pipe(retry(1));
  }

  updateSchedule(id: number, data: Partial<{ name: string; cronExpression: string; isActive: boolean; environment: string; description: string }>): Observable<any> {
    return this.http.put(`${this.apiUrl}/schedules/${id}`, data);
  }

  deleteSchedule(id: number): Observable<any> {
    return this.http.delete(`${this.apiUrl}/schedules/${id}`);
  }

  // Live run updates are polled from the Java API.
  connectToRun(runId: number): void {
    this.liveLogs.set([]);
    this.artifactsReady.set([]);
    this.activeRunStatus.set('running');
    this.lastRunLogId = 0;
    this.seenRunLogKeys.clear();

    this.disconnectFromRun();
    this.holdRunSession(runId);

    const poll = () => {
      this.getLogs(runId).subscribe({
        next: logs => {
          const fresh = logs.filter(log => {
            if (typeof log.id === 'number') {
              if (log.id <= this.lastRunLogId) return false;
              this.lastRunLogId = Math.max(this.lastRunLogId, log.id);
              return true;
            }
            const key = `${log.timestamp}|${log.level}|${log.message}`;
            if (this.seenRunLogKeys.has(key)) return false;
            this.seenRunLogKeys.add(key);
            return true;
          });
          if (fresh.length > 0) this.liveLogs.set(fresh);
        },
        error: () => {},
      });

      this.getRunDetails(runId).subscribe({
        next: run => {
          this.activeRunStatus.set(run.status);
          if (this.isSessionProtectedRunStatus(run.status)) {
            this.holdRunSession(runId);
          } else {
            this.releaseRunSession();
          }
          if (run.status !== 'queued' && run.status !== 'running' && run.status !== 'paused') {
            this.getArtifacts(runId).subscribe({
              next: artifacts => this.artifactsReady.set(artifacts),
              error: () => {},
            });
            this.disconnectFromRun();
          }
        },
        error: () => {},
      });
    };

    poll();
    this.runPollHandle = window.setInterval(poll, 2000);
  }

  disconnectFromRun(): void {
    if (this.runPollHandle !== null) {
      window.clearInterval(this.runPollHandle);
      this.runPollHandle = null;
    }
    this.releaseRunSession();
    this.lastRunLogId = 0;
    this.seenRunLogKeys.clear();
  }

  private holdRunSession(runId: number): void {
    const key = `execution-run-${runId}`;
    if (this.currentRunSessionHoldKey && this.currentRunSessionHoldKey !== key) {
      this.sessionService.releaseExecutionTimeout(this.currentRunSessionHoldKey);
    }
    this.currentRunSessionHoldKey = key;
    this.sessionService.holdExecutionTimeout(key);
  }

  private releaseRunSession(): void {
    if (!this.currentRunSessionHoldKey) return;
    this.sessionService.releaseExecutionTimeout(this.currentRunSessionHoldKey);
    this.currentRunSessionHoldKey = null;
  }
}
