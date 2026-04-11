import { Component, OnInit, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { TableModule } from 'primeng/table';
import { TabsModule } from 'primeng/tabs';
import { TooltipModule } from 'primeng/tooltip';
import { ProgressBarModule } from 'primeng/progressbar';
import { ExecutionService } from '../../services/execution.service';
import { ExecutionRun, ExecutionLog } from '../../models/interfaces';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-run-detail',
  standalone: true,
  imports: [CommonModule, RouterModule, CardModule, ButtonModule, TagModule, TableModule, TabsModule, TooltipModule, ProgressBarModule],
  templateUrl: './run-detail.html',
  styleUrl: './run-detail.scss',
})
export class RunDetail implements OnInit, OnDestroy {
  run = signal<ExecutionRun | null>(null);
  logs = signal<ExecutionLog[]>([]);
  liveLogs = signal<string[]>([]);
  loading = signal(true);
  runId = 0;

  constructor(
    private route: ActivatedRoute,
    private executionService: ExecutionService,
    public auth: AuthService
  ) {}

  ngOnInit() {
    this.runId = Number(this.route.snapshot.paramMap.get('id'));
    this.loadRunDetails();
    this.loadLogs();
  }

  ngOnDestroy() {
    this.executionService.disconnectFromRun();
  }

  loadRunDetails() {
    this.loading.set(true);
    this.executionService.getRunDetails(this.runId).subscribe({
      next: (data) => {
        this.run.set(data);
        this.loading.set(false);

        if (data.status === 'running') {
          this.executionService.connectToRun(this.runId);
        }
      },
      error: () => this.loading.set(false),
    });
  }

  loadLogs() {
    this.executionService.getLogs(this.runId).subscribe({
      next: (data) => this.logs.set(data),
    });
  }

  stopRun() {
    if (!this.auth.canEdit()) return;
    this.executionService.stopRun(this.runId).subscribe({
      next: () => this.loadRunDetails(),
    });
  }

  getStatusSeverity(status: string): 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' {
    switch (status) {
      case 'passed': return 'success';
      case 'failed': return 'danger';
      case 'running': return 'warn';
      case 'queued': return 'info';
      case 'stopped': return 'secondary';
      case 'error': return 'danger';
      default: return 'secondary';
    }
  }

  formatDate(date: string | undefined): string {
    if (!date) return '-';
    return new Date(date).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  formatDuration(seconds: number | null | undefined): string {
    if (!seconds) return '-';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  get passRate(): number {
    const r = this.run();
    if (!r || !r.totalScripts) return 0;
    return Math.round(((r.passedCount || 0) / r.totalScripts) * 100);
  }
}
