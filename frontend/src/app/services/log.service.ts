import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';

export interface AppLog {
  id: string;
  severity: 'success' | 'error' | 'warn' | 'info';
  summary: string;
  detail: string;
  timestamp: Date;
  icon: string;
  source?: string;
  category?: string;
  userId?: number;
}

@Injectable({ providedIn: 'root' })
export class LogService {
  logs = signal<AppLog[]>([]);
  loading = signal(false);
  selectedDateFrom = signal<Date | null>(null);
  selectedDateTo = signal<Date | null>(null);

  constructor(private http: HttpClient) {}

  private readonly apiUrl = '/api/logs';

  load() {
    this.loading.set(true);
    this.http.get<any[]>(this.apiUrl).subscribe({
      next: (data) => {
        console.log('Logs fetched:', data.length);
        if (!Array.isArray(data)) return;

        const mapped = data.map(l => ({
          id: l.id?.toString() || Math.random().toString(),
          severity: l.severity || 'info',
          summary: l.summary,
          detail: l.detail,
          timestamp: new Date(l.created_at || l.timestamp),
          icon: l.icon || 'pi pi-info-circle',
          source: l.source || 'System',
          category: l.category || 'General',
          userId: l.user_id,
        } as AppLog));

        this.logs.set(mapped);
        this.loading.set(false);
      },
      error: (err) => {
        console.error('Failed to load logs:', err);
        this.loading.set(false);
      }
    });
  }

  add(log: Omit<AppLog, 'id' | 'timestamp'>) {
    const newLog: AppLog = {
      ...log,
      id: Math.random().toString(36).substr(2, 9),
      timestamp: new Date(),
    };
    this.logs.update(l => [newLog, ...l]);
    this.http.post<any>(this.apiUrl, log).subscribe({
      error: (err) => console.error('Failed to save log:', err)
    });
  }

  getLogsByDateRange(from: Date, to: Date): AppLog[] {
    return this.logs().filter(log =>
      log.timestamp >= from && log.timestamp <= to
    );
  }

  getLogsByDate(date: Date): AppLog[] {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    return this.logs().filter(log =>
      log.timestamp >= startOfDay && log.timestamp <= endOfDay
    );
  }

  getTodayLogs(): AppLog[] {
    return this.getLogsByDate(new Date());
  }

  getSeverityIcon(severity: string): string {
    const icons: Record<string, string> = {
      success: 'pi pi-check-circle',
      error: 'pi pi-exclamation-circle',
      warn: 'pi pi-exclamation-triangle',
      info: 'pi pi-info-circle'
    };
    return icons[severity] || 'pi pi-info-circle';
  }

  getSeverityColor(severity: string): string {
    const colors: Record<string, string> = {
      success: '#10b981',
      error: '#ef4444',
      warn: '#f59e0b',
      info: '#3b82f6'
    };
    return colors[severity] || '#6b7280';
  }

  exportToCSV(logs: AppLog[]): void {
    const headers = ['Timestamp', 'Severity', 'Summary', 'Detail', 'Source', 'Category'];
    const now = new Date();
    
    // Build CSV content
    const csvContent = [
      'Noesis Testing - Execution Logs Export',
      `Generated: ${now.toLocaleString()}`,
      `Total Records: ${logs.length}`,
      '',
      headers.join(','),
      ...logs.map(l => 
        [
          `"${new Date(l.timestamp).toLocaleString()}"`,
          `"${l.severity}"`,
          `"${l.summary}"`,
          `"${l.detail}"`,
          `"${l.source || 'System'}"`,
          `"${l.category || 'General'}"`
        ].join(',')
      )
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Noesis-Testing-Logs-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    window.URL.revokeObjectURL(url);
  }

  exportToPDF(logs: AppLog[]): void {
    const now = new Date();
    const severityBorder: Record<string, string> = {
      success: '#10b981',
      error: '#ef4444',
      warn: '#f59e0b',
      info: '#3b82f6'
    };

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Noesis Testing - Execution Logs</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            background: white;
            color: #333;
            padding: 40px;
          }
          .header {
            border-bottom: 3px solid #6366f1;
            padding-bottom: 20px;
            margin-bottom: 30px;
          }
          .logo {
            font-size: 24px;
            font-weight: bold;
            color: #6366f1;
            margin-bottom: 8px;
          }
          .meta {
            font-size: 12px;
            color: #6b7280;
            display: flex;
            justify-content: space-between;
          }
          .log-entry {
            border-left: 5px solid #d1d5db;
            padding: 16px;
            margin: 16px 0;
            background: #f9fafb;
            page-break-inside: avoid;
          }
          .log-entry.success { border-left-color: #10b981; background: #f0fdf4; }
          .log-entry.error { border-left-color: #ef4444; background: #fef2f2; }
          .log-entry.warn { border-left-color: #f59e0b; background: #fffbeb; }
          .log-entry.info { border-left-color: #3b82f6; background: #eff6ff; }
          .log-summary {
            font-weight: 600;
            color: #1f2937;
            margin-bottom: 6px;
            font-size: 14px;
          }
          .log-detail {
            color: #6b7280;
            margin-bottom: 8px;
            font-size: 12px;
            line-height: 1.4;
          }
          .log-meta {
            display: flex;
            gap: 16px;
            font-size: 11px;
            color: #9ca3af;
          }
          .log-meta span {
            background: white;
            padding: 2px 8px;
            border-radius: 4px;
          }
          .summary {
            margin: 20px 0;
            padding: 12px;
            background: #f3f4f6;
            border-radius: 6px;
            font-size: 12px;
            color: #6b7280;
          }
          @media print {
            body { padding: 20px; }
            .log-entry { page-break-inside: avoid; }
          }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="logo">Noesis Testing</div>
          <div style="color: #6b7280; font-size: 14px; margin-bottom: 8px;">Execution Logs Report</div>
          <div class="meta">
            <span>Generated: ${now.toLocaleString()}</span>
            <span>Total Records: ${logs.length}</span>
          </div>
        </div>
        
        <div class="summary">
          Success: ${logs.filter(l => l.severity === 'success').length} | 
          Errors: ${logs.filter(l => l.severity === 'error').length} | 
          Warnings: ${logs.filter(l => l.severity === 'warn').length} | 
          Info: ${logs.filter(l => l.severity === 'info').length}
        </div>

        ${logs.map(l => `
          <div class="log-entry ${l.severity}">
            <div class="log-summary">${l.summary}</div>
            <div class="log-detail">${l.detail}</div>
            <div class="log-meta">
              <span>⏱ ${new Date(l.timestamp).toLocaleString()}</span>
              <span>📁 ${l.source || 'System'}</span>
              <span>🏷 ${l.category || 'General'}</span>
            </div>
          </div>
        `).join('')}

        <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #e5e7eb; text-align: center; color: #9ca3af; font-size: 11px;">
          <p>This report was generated by Noesis Testing</p>
        </div>
      </body>
      </html>
    `;

    const printWindow = window.open('', '', 'height=600,width=900');
    if (printWindow) {
      printWindow.document.write(htmlContent);
      printWindow.document.close();
      setTimeout(() => {
        printWindow.print();
      }, 250);
    }
  }
}
