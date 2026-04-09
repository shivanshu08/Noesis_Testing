import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { TableModule } from 'primeng/table';
import { ProgressBarModule } from 'primeng/progressbar';
import { ExecutionService } from '../../services/execution.service';
import { ScriptService } from '../../services/script.service';
import { DashboardStats, ExecutionRun, ScriptCategory } from '../../models/interfaces';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterModule, CardModule, ButtonModule, TagModule, TableModule, ProgressBarModule],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard implements OnInit {
  stats = signal<DashboardStats | null>(null);
  recentRuns = signal<ExecutionRun[]>([]);
  categories = signal<ScriptCategory[]>([]);
  loading = signal(true);

  constructor(
    private executionService: ExecutionService,
    private scriptService: ScriptService,
  ) {}

  ngOnInit() {
    this.loadData();
  }

  loadData() {
    this.loading.set(true);

    this.executionService.getStats().subscribe({
      next: (data) => this.stats.set(data),
      error: () => {},
    });

    this.executionService.getRuns({ limit: 8 }).subscribe({
      next: (data) => this.recentRuns.set(data),
      error: () => {},
    });

    this.scriptService.getCategories().subscribe({
      next: (data) => {
        this.categories.set(data);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  getStatusSeverity(status: string): 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' {
    switch (status) {
      case 'passed': return 'success';
      case 'failed': return 'danger';
      case 'running': return 'warn';
      case 'queued': return 'info';
      case 'stopped': return 'secondary';
      default: return 'secondary';
    }
  }

  getPassRate(): number {
    const s = this.stats();
    if (!s) return 0;
    return Math.round(s.passRate);
  }

  formatDate(date: string): string {
    return new Date(date).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  formatDuration(seconds: number | null): string {
    if (!seconds) return '-';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }
}
