import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { CardModule } from 'primeng/card';
import { ProgressBarModule } from 'primeng/progressbar';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { ExecutionRun } from '../../models/interfaces';
import { ExecutionService } from '../../services/execution.service';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-running-now',
  standalone: true,
  imports: [CommonModule, RouterModule, ButtonModule, TableModule, TagModule, CardModule, ProgressBarModule, TooltipModule],
  providers: [MessageService],
  templateUrl: './running-now.html',
  styleUrl: './running-now.scss',
})
export class RunningNow implements OnInit, OnDestroy {
  readonly runs = signal<ExecutionRun[]>([]);
  readonly loading = signal(true);
  readonly busyRunIds = signal<number[]>([]);
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly executionService: ExecutionService,
    private readonly messageService: MessageService,
    public readonly auth: AuthService
  ) {}

  ngOnInit(): void {
    this.loadRuns();
    this.refreshTimer = setInterval(() => this.loadRuns(false), 5000);
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  loadRuns(showLoader = true): void {
    if (showLoader) this.loading.set(true);
    this.executionService.getRuns({ limit: 200 }).subscribe({
      next: (runs) => {
        this.runs.set(runs.filter((run) => ['queued', 'running', 'paused'].includes(String(run.status).toLowerCase())));
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.messageService.add({ severity: 'error', summary: 'Load Failed', detail: 'Could not load running executions.' });
      },
    });
  }

  pause(run: ExecutionRun): void {
    this.control(run.id, 'pause', () => this.executionService.pauseRun(run.id), 'Pause requested.');
  }

  resume(run: ExecutionRun): void {
    this.control(run.id, 'resume', () => this.executionService.resumeRun(run.id), 'Resume requested.');
  }

  rebuild(run: ExecutionRun): void {
    this.control(run.id, 'rebuild', () => this.executionService.rebuildRun(run.id), 'Rebuild started.');
  }

  stop(run: ExecutionRun): void {
    this.control(run.id, 'stop', () => this.executionService.stopRun(run.id), 'Stop requested.');
  }

  isBusy(runId: number): boolean {
    return this.busyRunIds().includes(runId);
  }

  canPause(run: ExecutionRun): boolean {
    return ['queued', 'running'].includes(String(run.status).toLowerCase());
  }

  canResume(run: ExecutionRun): boolean {
    return String(run.status).toLowerCase() === 'paused';
  }

  canRebuild(run: ExecutionRun): boolean {
    return String(run.status).toLowerCase() === 'paused';
  }

  progress(run: ExecutionRun): number {
    const total = Number(run.totalScripts || 0);
    if (total <= 0) return 0;
    const done = Number(run.passedCount || 0) + Number(run.failedCount || 0) + Number(run.errorCount || 0) + Number(run.skippedCount || 0);
    return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  }

  statusSeverity(status: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast' {
    switch (String(status || '').toLowerCase()) {
      case 'running': return 'warn';
      case 'paused': return 'info';
      case 'queued': return 'secondary';
      case 'failed':
      case 'error': return 'danger';
      case 'passed': return 'success';
      default: return 'secondary';
    }
  }

  private control(runId: number, action: string, request: () => ReturnType<ExecutionService['stopRun']>, successDetail: string): void {
    if (this.isBusy(runId)) return;
    this.busyRunIds.update((ids) => [...ids, runId]);
    request().subscribe({
      next: () => {
        this.messageService.add({ severity: 'success', summary: `${this.title(action)} Accepted`, detail: successDetail });
        this.busyRunIds.update((ids) => ids.filter((id) => id !== runId));
        this.loadRuns(false);
      },
      error: (err) => {
        this.busyRunIds.update((ids) => ids.filter((id) => id !== runId));
        this.messageService.add({
          severity: 'error',
          summary: `${this.title(action)} Failed`,
          detail: err?.error?.error || `Could not ${action} this run.`,
        });
      },
    });
  }

  private title(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
}
