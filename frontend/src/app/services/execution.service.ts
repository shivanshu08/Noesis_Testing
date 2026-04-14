import { Injectable, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, Subject, retry } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../environments/environment';
import { ExecutionRun, ExecutionLog, DashboardStats, ScheduledRun, ExecutionArtifact } from '../models/interfaces';

@Injectable({ providedIn: 'root' })
export class ExecutionService {
  private readonly apiUrl = `${environment.apiUrl}/execution`;
  private readonly logsApiUrl = `${environment.apiUrl}/logs`;
  private socket: Socket | null = null;
  private globalSocket: Socket | null = null;

  readonly liveLogs = signal<ExecutionLog[]>([]);
  readonly activeRunStatus = signal<string | null>(null);
  readonly artifactsReady = signal<ExecutionArtifact[]>([]);
  
  readonly globalRunUpdates = new Subject<any>();

  constructor(private http: HttpClient) {}

  initGlobalSocket(): void {
    if (!this.globalSocket) {
      this.globalSocket = io(environment.wsUrl, { transports: ['websocket', 'polling'] });
      this.globalSocket.on('global-run-status', (data) => {
        this.globalRunUpdates.next(data);
      });
    }
  }

  runScripts(scriptIds: number[], suiteName?: string): Observable<{
    runId: number;
    message: string;
    totalScripts: number;
    resolvedScriptIds?: number[];
    autoIncludedDependencyIds?: number[];
  }> {
    return this.http.post<{
      runId: number;
      message: string;
      totalScripts: number;
      resolvedScriptIds?: number[];
      autoIncludedDependencyIds?: number[];
    }>(`${this.apiUrl}/run`, {
      scriptIds,
      suiteName,
    });
  }

  stopRun(runId: number): Observable<any> {
    return this.http.post(`${this.apiUrl}/stop/${runId}`, {});
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

  getGlobalLogs(filters?: {
    days?: number;
    severity?: string;
    runId?: number;
    q?: string;
    module?: string;
    action?: string;
    status?: string;
    from?: string;
    to?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
    limit?: number;
    offset?: number;
  }): Observable<{
    data: any[];
    summary?: {
      total: number;
      errorCount: number;
      warnCount: number;
      infoCount: number;
      debugCount: number;
      uniqueRunCount: number;
    };
    meta?: { total: number; limit: number; offset: number };
  }> {
    let params = new HttpParams();
    if (filters?.days !== undefined) params = params.set('days', filters.days.toString());
    if (filters?.severity) params = params.set('severity', filters.severity);
    if (filters?.runId !== undefined) params = params.set('runId', filters.runId.toString());
    if (filters?.q) params = params.set('q', filters.q);
    if (filters?.module) params = params.set('module', filters.module);
    if (filters?.action) params = params.set('action', filters.action);
    if (filters?.status) params = params.set('status', filters.status);
    if (filters?.from) params = params.set('from', filters.from);
    if (filters?.to) params = params.set('to', filters.to);
    if (filters?.sortBy) params = params.set('sortBy', filters.sortBy);
    if (filters?.sortOrder) params = params.set('sortOrder', filters.sortOrder);
    if (filters?.limit !== undefined) params = params.set('limit', filters.limit.toString());
    if (filters?.offset !== undefined) params = params.set('offset', filters.offset.toString());

    return this.http.get<{
      data: any[];
      summary?: {
        total: number;
        errorCount: number;
        warnCount: number;
        infoCount: number;
        debugCount: number;
        uniqueRunCount: number;
      };
      meta?: { total: number; limit: number; offset: number };
    }>(`${this.apiUrl}/global-logs`, { params });
  }

  getLogModules(filters?: {
    from?: string;
    to?: string;
    q?: string;
  }): Observable<Array<{ value: string; label: string; count: number }>> {
    let params = new HttpParams();
    if (filters?.from) params = params.set('from', filters.from);
    if (filters?.to) params = params.set('to', filters.to);
    if (filters?.q) params = params.set('q', filters.q);
    return this.http.get<Array<{ value: string; label: string; count: number }>>(
      `${this.logsApiUrl}/modules`,
      { params }
    );
  }

  getLogActions(filters?: {
    from?: string;
    to?: string;
    q?: string;
    module?: string;
  }): Observable<Array<{ value: string; label: string; count: number }>> {
    let params = new HttpParams();
    if (filters?.from) params = params.set('from', filters.from);
    if (filters?.to) params = params.set('to', filters.to);
    if (filters?.q) params = params.set('q', filters.q);
    if (filters?.module) params = params.set('module', filters.module);
    return this.http.get<Array<{ value: string; label: string; count: number }>>(
      `${this.logsApiUrl}/actions`,
      { params }
    );
  }

  deleteGlobalLog(id: number | string): Observable<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(`${this.apiUrl}/global-logs/${id}`);
  }

  deleteGlobalLogs(ids: Array<number | string>): Observable<{ success: boolean }> {
    return this.http.post<{ success: boolean }>(`${this.apiUrl}/global-logs/delete-multiple`, { ids });
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

  // WebSocket for live log streaming
  connectToRun(runId: number): void {
    this.liveLogs.set([]);
    this.artifactsReady.set([]);
    this.activeRunStatus.set('running');

    if (this.socket) {
      this.socket.disconnect();
    }

    this.socket = io(environment.wsUrl, {
      transports: ['websocket', 'polling'],
    });

    this.socket.on('connect', () => {
      this.socket?.emit('join-run', runId);
    });

    this.socket.on('run-log', (log: ExecutionLog) => {
      this.liveLogs.update(logs => [...logs, log]);
    });

    this.socket.on('run-completed', (data: any) => {
      this.activeRunStatus.set(data.status);
    });

    this.socket.on('run-artifacts-ready', (artifacts: ExecutionArtifact[]) => {
      this.artifactsReady.set(artifacts);
    });

    this.socket.on('run-stopped', () => {
      this.activeRunStatus.set('stopped');
    });

    this.socket.on('run-error', (data: any) => {
      this.activeRunStatus.set('error');
    });
  }

  disconnectFromRun(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }
}
