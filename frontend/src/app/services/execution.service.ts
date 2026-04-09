import { Injectable, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../environments/environment';
import { ExecutionRun, ExecutionLog, DashboardStats } from '../models/interfaces';

@Injectable({ providedIn: 'root' })
export class ExecutionService {
  private readonly apiUrl = `${environment.apiUrl}/execution`;
  private socket: Socket | null = null;

  readonly liveLogs = signal<ExecutionLog[]>([]);
  readonly activeRunStatus = signal<string | null>(null);

  constructor(private http: HttpClient) {}

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
    return this.http.get<ExecutionRun[]>(`${this.apiUrl}/runs`, { params });
  }

  getRunDetails(runId: number): Observable<ExecutionRun> {
    return this.http.get<ExecutionRun>(`${this.apiUrl}/runs/${runId}`);
  }

  getStats(): Observable<DashboardStats> {
    return this.http.get<DashboardStats>(`${this.apiUrl}/stats`);
  }

  getLogs(runId: number): Observable<ExecutionLog[]> {
    return this.http.get<ExecutionLog[]>(`${this.apiUrl}/logs/${runId}`);
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
