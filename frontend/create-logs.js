const fs = require('fs');

const content = `import { Component, OnInit, signal, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';
import { ThemeService } from '../../services/theme.service';

export interface AppLog {
  id: number;
  severity: string;
  summary: string;
  detail: string;
  time: Date;
  source: string;
  category: string;
}

@Component({
  selector: 'app-logs',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ConfirmDialogModule,
    ToastModule,
  ],
  providers: [ConfirmationService, MessageService],
  templateUrl: './logs.html',
  styleUrl: './logs.scss',
})
export class LogsPage implements OnInit, OnDestroy {
  allLogs = signal<AppLog[]>([]);
  filteredLogs = signal<AppLog[]>([]);
  selectedLogs = signal<AppLog[]>([]);
  loading = signal(true);

  dateFrom = '';
  dateTo = '';
  searchTerm = '';
  selectedSeverity = '';

  severityOptions = [
    { label: 'All', value: '' },
    { label: 'Success', value: 'success' },
    { label: 'Error', value: 'error' },
    { label: 'Warning', value: 'warn' },
    { label: 'Info', value: 'info' },
  ];

  private pollingInterval: any;
  private readonly apiUrl = 'http://localhost:3000/api/execution';

  constructor(
    public themeService: ThemeService,
    private http: HttpClient,
    private confirmationService: ConfirmationService,
    private messageService: MessageService
  ) {}

  ngOnInit() {
    this.setDateRange(1);
    this.fetchLogs();
    this.pollingInterval = setInterval(() => this.fetchLogs(false), 15000);
  }

  ngOnDestroy() {
    if (this.pollingInterval) clearInterval(this.pollingInterval);
  }

  fetchLogs(showSpinner = true) {
    if (showSpinner) this.loading.set(true);

    this.http.get<any[]>(\\\`\\\${this.apiUrl}/global-logs?days=365\\\`).subscribe({
      next: (data) => {
        const mapped = data.map(log => ({ ...log, time: new Date(log.time) }));
        this.allLogs.set(mapped);
        this.applyFilters();
        this.loading.set(false);
      },
      error: (err) => {
        console.error(err);
        if (showSpinner) {
          this.messageService.add({ severity: 'error', summary: 'Error', detail: 'Failed to fetch logs' });
        }
        this.loading.set(false);
      }
    });
  }

  applyFilters() {
    let filtered = [...this.allLogs()];

    if (this.dateFrom) {
      const fromDate = new Date(this.dateFrom);
      fromDate.setHours(0, 0, 0, 0);
      filtered = filtered.filter(l => new Date(l.time) >= fromDate);
    }

    if (this.dateTo) {
      const toDate = new Date(this.dateTo);
      toDate.setHours(23, 59, 59, 999);
      filtered = filtered.filter(l => new Date(l.time) <= toDate);
    }

    if (this.selectedSeverity) {
      filtered = filtered.filter(l => l.severity === this.selectedSeverity);
    }

    if (this.searchTerm) {
      const search = this.searchTerm.toLowerCase();
      filtered = filtered.filter(l =>
        l.summary.toLowerCase().includes(search) ||
        l.detail.toLowerCase().includes(search) ||
        l.source?.toLowerCase().includes(search) ||
        l.category?.toLowerCase().includes(search)
      );
    }

    this.filteredLogs.set(filtered);
  }

  onFilterChange() {
    this.applyFilters();
  }

  setDateRange(days: number) {
    if (days === 0) {
      this.dateFrom = '';
      this.dateTo = '';
    } else {
      const now = new Date();
      const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      this.dateFrom = from.toISOString().split('T')[0];
      this.dateTo = now.toISOString().split('T')[0];
    }
    this.applyFilters();
  }

  clearAllFilters() {
    this.searchTerm = '';
    this.selectedSeverity = '';
    this.dateFrom = '';
    this.dateTo = '';
    this.applyFilters();
  }

  deleteLog(log: AppLog) {
    this.confirmationService.confirm({
      message: 'Are you sure you want to delete this log?',
      header: 'Confirm',
      icon: 'pi pi-exclamation-triangle',
      accept: () => {
        this.http.delete(\\\`\\\${this.apiUrl}/global-logs/\\\${log.id}\\\`).subscribe({
          next: () => {
            this.allLogs.update(logs => logs.filter(l => l.id !== log.id));
            this.applyFilters();
            this.messageService.add({
              severity: 'success',
              summary: 'Deleted',
              detail: 'Log entry removed',
              life: 2000,
            });
          },
          error: () => {
            this.messageService.add({
              severity: 'error',
              summary: 'Error',
              detail: 'Failed to delete log',
              life: 2000,
            });
          }
        });
      },
    });
  }

  deleteSelected() {
    if (this.selectedLogs().length === 0) {
      this.messageService.add({
        severity: 'warn',
        summary: 'No Selection',
        detail: 'Please select logs to delete',
        life: 2000,
      });
      return;
    }

    this.confirmationService.confirm({
      message: \\\`Delete \\\${this.selectedLogs().length} log(s)?\\\`,
      header: 'Confirm',
      icon: 'pi pi-exclamation-triangle',
      accept: () => {
        const ids = this.selectedLogs().map(l => l.id);
        this.http.post(\\\`\\\${this.apiUrl}/global-logs/delete-multiple\\\`, { ids }).subscribe({
          next: () => {
            this.allLogs.update(logs => logs.filter(l => !ids.includes(l.id)));
            this.selectedLogs.set([]);
            this.applyFilters();
            this.messageService.add({
              severity: 'success',
              summary: 'Deleted',
              detail: \\\`\\\${ids.length} log(s) removed\\\`,
              life: 2000,
            });
          },
          error: () => {
            this.messageService.add({
              severity: 'error',
              summary: 'Error',
              detail: 'Failed to delete logs',
              life: 2000,
            });
          }
        });
      },
    });
  }

  exportToCSV() {
    const logs = this.filteredLogs();
    const headers = ['Timestamp', 'Severity', 'Summary', 'Detail', 'Source', 'Category'];
    const now = new Date();
    const csvContent = [
      'Noesis Testing - Execution Logs Export',
      \\\`Generated: \\\${now.toLocaleString()}\\\`,
      \\\`Total Records: \\\${logs.length}\\\`,
      '',
      headers.join(','),
      ...logs.map(log =>
        [
          \\\`"\\\${new Date(log.time).toLocaleString()}"\\\`,
          \\\`"\\\${log.severity}"\\\`,
          \\\`"\\\${log.summary}"\\\`,
          \\\`"\\\${log.detail}"\\\`,
          \\\`"\\\${log.source || 'System'}"\\\`,
          \\\`"\\\${log.category || 'General'}"\\\`
        ].join(',')
      )
    ].join('\\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = \\\`Noesis-Testing-Logs-\\\${now.toISOString().split('T')[0]}.csv\\\`;
    link.click();
    window.URL.revokeObjectURL(url);

    this.messageService.add({
      severity: 'success',
      summary: 'Exported',
      detail: 'Logs exported to CSV successfully',
      life: 3000,
    });
  }

  formatDate(date: Date | string): string {
    return new Date(date).toLocaleDateString();
  }

  formatTime(date: Date): string {
    return new Date(date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  getSeverityIcon(severity: string): string {
    const icons: Record<string, string> = {
      success: 'pi pi-check-circle',
      error: 'pi pi-exclamation-circle',
      warn: 'pi pi-exclamation-triangle',
      info: 'pi pi-info-circle',
    };
    return icons[severity] || 'pi pi-info-circle';
  }

  getSeverityColor(severity: string): string {
    const colors: Record<string, string> = {
      success: '#10b981',
      error: '#ef4444',
      warn: '#f59e0b',
      info: '#3b82f6',
    };
    return colors[severity] || '#6b7280';
  }
}
`;

fs.writeFileSync('c:\\\\Users\\\\Shivanshu Dwivedi\\\\OneDrive - Drogevate Solutions Private Limited\\\\Noesis_Testing\\\\frontend\\\\src\\\\app\\\\pages\\\\logs\\\\logs.ts', content, 'utf8');
console.log('logs.ts file created successfully');
