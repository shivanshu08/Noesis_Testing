import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';

export interface AppNotification {
  id: string;
  severity: 'success' | 'error' | 'warn' | 'info';
  summary: string;
  detail: string;
  time: Date;
  icon: string;
  read: boolean;
  source?: string; // e.g., 'Script Execution', 'System', 'User Action'
  category?: string; // e.g., 'Test Run', 'Configuration', 'Authentication'
  actionUrl?: string; // For navigating to related content
}

@Injectable({ providedIn: 'root' })
export class NotificationService {
  notifications = signal<AppNotification[]>([]);
  unreadCount = signal(0);
  loading = signal(false);

  constructor(private http: HttpClient) {}
  
  // Relative URL ensures Angular Auth Interceptors attach the JWT token properly!
  private readonly apiUrl = '/api/notifications';

  load(days: number = 30) {
    this.loading.set(true);
    this.http.get<any[]>(`${this.apiUrl}?days=${days}`).subscribe({
      next: (data) => {
        console.log('Database Notifications Fetched:', data);
        if (!Array.isArray(data)) return;
        
        const mapped = data.map(n => ({
          id: n.id.toString(),
          severity: n.severity || 'info',
          summary: n.summary,
          detail: n.detail,
          time: new Date(n.created_at),
          icon: n.icon,
          read: n.is_read,
          source: n.source || 'System',
          category: n.category || 'General',
          actionUrl: n.action_url
        } as AppNotification));
        this.notifications.set(mapped);
        this.unreadCount.set(mapped.filter(n => !n.read).length);
        this.loading.set(false);
      },
      error: (err) => {
        console.error('Failed to load notifications from backend:', err);
        this.loading.set(false);
      }
    });
  }

  add(notif: Omit<AppNotification, 'id' | 'time' | 'read'>) {
    this.http.post<any>(this.apiUrl, notif).subscribe({
      next: (savedNotif) => {
        const newNotif: AppNotification = {
          ...notif,
          id: savedNotif.id.toString(),
          time: new Date(savedNotif.created_at),
          read: false
        };
        this.notifications.update(n => [newNotif, ...n]);
        this.unreadCount.update(c => c + 1);
      }
    });
  }

  markAllRead() {
    if (this.unreadCount() === 0) return;
    this.http.put(`${this.apiUrl}/read`, {}).subscribe({
      next: () => {
        this.notifications.update(n => n.map(x => ({ ...x, read: true })));
        this.unreadCount.set(0);
      }
    });
  }

  delete(id: string) {
    this.http.delete(`${this.apiUrl}/${id}`).subscribe({
      next: () => {
        const notif = this.notifications().find(n => n.id === id);
        if (notif && !notif.read) {
          this.unreadCount.update(c => Math.max(0, c - 1));
        }
        this.notifications.update(n => n.filter(x => x.id !== id));
      }
    });
  }

  clearAll() {
    this.http.delete(this.apiUrl).subscribe({
      next: () => {
        this.notifications.set([]);
        this.unreadCount.set(0);
      }
    });
  }

  deleteMultiple(ids: string[]) {
    return this.http.post(`${this.apiUrl}/delete-multiple`, { ids });
  }

  markAsRead(id: string) {
    return this.http.put(`${this.apiUrl}/${id}/read`, {});
  }

  markMultipleAsRead(ids: string[]) {
    return this.http.post(`${this.apiUrl}/mark-read`, { ids });
  }

  // Filter notifications by various criteria
  filterNotifications(notifications: AppNotification[], filters: {
    severity?: string;
    source?: string;
    category?: string;
    readStatus?: 'all' | 'read' | 'unread';
    searchTerm?: string;
    dateRange?: { start: Date; end: Date };
  }): AppNotification[] {
    let result = [...notifications];

    if (filters.severity && filters.severity !== 'all') {
      result = result.filter(n => n.severity === filters.severity);
    }

    if (filters.source && filters.source !== 'all') {
      result = result.filter(n => n.source === filters.source);
    }

    if (filters.category && filters.category !== 'all') {
      result = result.filter(n => n.category === filters.category);
    }

    if (filters.readStatus && filters.readStatus !== 'all') {
      result = result.filter(n => filters.readStatus === 'read' ? n.read : !n.read);
    }

    if (filters.searchTerm) {
      const term = filters.searchTerm.toLowerCase();
      result = result.filter(n =>
        n.summary.toLowerCase().includes(term) ||
        n.detail.toLowerCase().includes(term) ||
        n.source?.toLowerCase().includes(term)
      );
    }

    if (filters.dateRange) {
      result = result.filter(n =>
        n.time >= filters.dateRange!.start && n.time <= filters.dateRange!.end
      );
    }

    return result;
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

  getSeverityIcon(severity: string): string {
    const icons: Record<string, string> = {
      success: 'pi pi-check',
      error: 'pi pi-bolt',
      warn: 'pi pi-exclamation-triangle',
      info: 'pi pi-bell'
    };
    return icons[severity] || 'pi pi-bell';
  }

  getUniqueSources(): string[] {
    const sources = new Set(this.notifications().map(n => n.source || 'System'));
    return Array.from(sources).sort();
  }

  getUniqueCategories(): string[] {
    const categories = new Set(this.notifications().map(n => n.category || 'General'));
    return Array.from(categories).sort();
  }

  exportToCSV(notifications: AppNotification[]): void {
    const headers = ['ID', 'Type', 'Summary', 'Detail', 'Severity', 'Source', 'Category', 'Date', 'Status'];
    const rows = notifications.map(n => [
      n.id,
      n.summary,
      n.detail,
      n.severity,
      n.source || 'System',
      n.category || 'General',
      new Date(n.time).toLocaleString(),
      n.read ? 'Read' : 'Unread'
    ]);

    const csv = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `notifications-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  }
}