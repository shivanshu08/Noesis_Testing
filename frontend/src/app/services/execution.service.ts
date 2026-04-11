import { Injectable, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, Subject, retry } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../environments/environment';
import { ExecutionRun, ExecutionLog, DashboardStats } from '../models/interfaces';

@Injectable({ providedIn: 'root' })
export class ExecutionService {
  private readonly apiUrl = `${environment.apiUrl}/execution`;
  private socket: Socket | null = null;
  private globalSocket: Socket | null = null;

  readonly liveLogs = signal<ExecutionLog[]>([]);
  readonly activeRunStatus = signal<string | null>(null);
  
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

  runScripts(scriptIds: number[], suiteName?: string): Observable<{ runId: number; message: string; totalScripts: number }> {
    return this.http.post<{ runId: number; message: string; totalScripts: number }>(`${this.apiUrl}/run`, {
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

  getGlobalLogs(filters?: {
    days?: number;
    severity?: string;
    runId?: number;
    q?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): Observable<{ data: any[]; meta?: { total: number; limit: number; offset: number } }> {
    let params = new HttpParams();
    if (filters?.days !== undefined) params = params.set('days', filters.days.toString());
    if (filters?.severity) params = params.set('severity', filters.severity);
    if (filters?.runId !== undefined) params = params.set('runId', filters.runId.toString());
    if (filters?.q) params = params.set('q', filters.q);
    if (filters?.from) params = params.set('from', filters.from);
    if (filters?.to) params = params.set('to', filters.to);
    if (filters?.limit !== undefined) params = params.set('limit', filters.limit.toString());
    if (filters?.offset !== undefined) params = params.set('offset', filters.offset.toString());

    return this.http.get<{ data: any[]; meta?: { total: number; limit: number; offset: number } }>(
      `${this.apiUrl}/global-logs`,
      { params }
    );
  }

  deleteGlobalLog(id: number | string): Observable<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(`${this.apiUrl}/global-logs/${id}`);
  }

  deleteGlobalLogs(ids: Array<number | string>): Observable<{ success: boolean }> {
    return this.http.post<{ success: boolean }>(`${this.apiUrl}/global-logs/delete-multiple`, { ids });
  }

  // WebSocket for live log streaming
  connectToRun(runId: number): void {
    this.liveLogs.set([]);
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
