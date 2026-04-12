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
  rows = 10;
  statusFilter: string | null = null;

  statusOptions = [
    { label: 'All Status', value: null },
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

  exportCSV() {
    const csvData = this.runs();
    if (!csvData || csvData.length === 0) {
      return;
    }

    const headers = ['Run ID', 'Name', 'Status', 'Total Scripts', 'Passed', 'Failed', 'Duration (s)', 'Started At', 'Triggered By'];
    const rows = csvData.map(run => {
      return [
        run.id,
        `"${run.runName || 'Manual Run'}"`,
        run.status,
        run.totalScripts || 0,
        run.passedCount || 0,
        run.failedCount || 0,
        run.durationMs ? (run.durationMs / 1000).toFixed(2) : 0,
        `"${run.startedAt ? new Date(run.startedAt).toISOString() : '-'}"`,
        `"${run.triggeredBy || '-'}"`
      ].join(',');
    });

    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Execution_History_${new Date().getTime()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}
