import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { FormsModule } from '@angular/forms';
import { TooltipModule } from 'primeng/tooltip';
import { ExecutionService } from '../../services/execution.service';
import { ExecutionRun } from '../../models/interfaces';

@Component({
  selector: 'app-history',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, CardModule, TableModule, ButtonModule, TagModule, SelectModule, TooltipModule],
  templateUrl: './history.html',
  styleUrl: './history.scss',
})
export class History implements OnInit {
  runs = signal<ExecutionRun[]>([]);
  loading = signal(true);
  totalRecords = signal(0);
  page = 1;
  rows = 20;
  statusFilter: string | null = null;

  statusOptions = [
    { label: 'Running', value: 'running' },
    { label: 'Passed', value: 'passed' },
    { label: 'Failed', value: 'failed' },
    { label: 'Stopped', value: 'stopped' },
    { label: 'Error', value: 'error' },
  ];

  constructor(private executionService: ExecutionService) {}

  ngOnInit() {
    this.loadRuns();
  }

  loadRuns() {
    this.loading.set(true);
    this.executionService.getRuns({
      status: this.statusFilter || undefined,
      limit: this.rows,
      offset: (this.page - 1) * this.rows,
    }).subscribe({
      next: (data) => {
        this.runs.set(data);
        this.totalRecords.set(data.length);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  onPageChange(event: any) {
    this.page = Math.floor(event.first / event.rows) + 1;
    this.rows = event.rows;
    this.loadRuns();
  }

  onStatusChange() {
    this.page = 1;
    this.loadRuns();
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

  formatDate(date: string): string {
    return new Date(date).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  formatDuration(seconds: number | null): string {
    if (!seconds) return '-';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }
}
