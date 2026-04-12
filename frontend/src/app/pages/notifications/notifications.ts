import { Component, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { DatePickerModule } from 'primeng/datepicker';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';

import { NotificationService, AppNotification } from '../../services/notification.service';

@Component({
  selector: 'app-notifications',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TableModule,
    CardModule,
    ButtonModule,
    InputTextModule,
    SelectModule,
    TagModule,
    TooltipModule,
    IconFieldModule,
    InputIconModule,
    DatePickerModule,
    ConfirmDialogModule,
    ToastModule,
  ],
  providers: [ConfirmationService, MessageService],
  templateUrl: './notifications.html',
  styleUrl: './notifications.scss',
})
export class Notifications implements OnInit {
  // Signals
  filteredNotifications = signal<AppNotification[]>([]);
  selectedNotifications = signal<AppNotification[]>([]);
  expandedRows: { [key: string]: boolean } = {};

  // Filter signals
  searchTerm = signal('');
  selectedSeverity = signal<string | undefined>(undefined);
  selectedSource = signal<string | undefined>(undefined);
  selectedCategory = signal<string | undefined>(undefined);
  selectedReadStatus = signal<'all' | 'read' | 'unread'>('all');
  dateFromFilter = signal<Date | undefined>(undefined);
  dateToFilter = signal<Date | undefined>(undefined);

  // Pagination
  rows = signal(10);

  // Severity counts for quick filter chips
  severityCounts = computed(() => {
    const all = this.notificationService.notifications();
    return {
      error: all.filter(n => n.severity === 'error').length,
      warn: all.filter(n => n.severity === 'warn').length,
      info: all.filter(n => n.severity === 'info').length,
      success: all.filter(n => n.severity === 'success').length,
    };
  });

  // Available filter options
  severityOptions = [
    { label: 'All Severities', value: undefined },
    { label: 'Success', value: 'success' },
    { label: 'Error', value: 'error' },
    { label: 'Warning', value: 'warn' },
    { label: 'Info', value: 'info' },
  ];

  readStatusOptions = [
    { label: 'All', value: 'all' },
    { label: 'Unread', value: 'unread' },
    { label: 'Read', value: 'read' },
  ];

  sourceOptions = computed(() => [
    { label: 'All Sources', value: undefined },
    ...this.notificationService.getUniqueSources().map(s => ({
      label: s,
      value: s,
    })),
  ]);

  categoryOptions = computed(() => [
    { label: 'All Categories', value: undefined },
    ...this.notificationService.getUniqueCategories().map(c => ({
      label: c,
      value: c,
    })),
  ]);

  constructor(
    public notificationService: NotificationService,
    private confirmationService: ConfirmationService,
    private messageService: MessageService
  ) {}

  ngOnInit() {
    this.notificationService.load(30);
    this.applyFilters();
  }

  quickFilterSeverity(severity: string | undefined) {
    if (this.selectedSeverity() === severity) {
      this.selectedSeverity.set(undefined);
    } else {
      this.selectedSeverity.set(severity);
    }
    this.applyFilters();
  }

  applyFilters() {
    const filters = {
      severity: this.selectedSeverity(),
      source: this.selectedSource(),
      category: this.selectedCategory(),
      readStatus: this.selectedReadStatus(),
      searchTerm: this.searchTerm(),
      dateRange: this.dateFromFilter() && this.dateToFilter()
        ? {
            start: this.dateFromFilter()!,
            end: this.dateToFilter()!,
          }
        : undefined,
    };

    const filtered = this.notificationService.filterNotifications(
      this.notificationService.notifications(),
      filters
    );

    filtered.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
    this.filteredNotifications.set(filtered);
  }

  onFilterChange() {
    this.applyFilters();
  }

  clearFilters() {
    this.searchTerm.set('');
    this.selectedSeverity.set(undefined);
    this.selectedSource.set(undefined);
    this.selectedCategory.set(undefined);
    this.selectedReadStatus.set('all');
    this.dateFromFilter.set(undefined);
    this.dateToFilter.set(undefined);
    this.applyFilters();
    this.messageService.add({ severity: 'info', summary: 'Filters Cleared', life: 2000 });
  }

  getSeverityIcon(severity: string): string {
    return this.notificationService.getSeverityIcon(severity);
  }

  getSeverityColor(severity: string): string {
    return this.notificationService.getSeverityColor(severity);
  }

  toggleExpanded(notifId: string) {
    this.expandedRows[notifId] = !this.expandedRows[notifId];
  }

  deleteNotification(notification: AppNotification) {
    this.confirmationService.confirm({
      message: `Delete notification: "${notification.summary}"?`,
      header: 'Confirm',
      icon: 'pi pi-exclamation-triangle',
      accept: () => {
        this.notificationService.delete(notification.id);
        this.applyFilters();
        this.messageService.add({
          severity: 'success',
          summary: 'Deleted',
          detail: 'Notification removed',
          life: 2000,
        });
      },
    });
  }

  deleteSelected() {
    if (this.selectedNotifications().length === 0) {
      this.messageService.add({
        severity: 'warn',
        summary: 'No Selection',
        detail: 'Please select notifications to delete',
        life: 2000,
      });
      return;
    }

    this.confirmationService.confirm({
      message: `Delete ${this.selectedNotifications().length} notification(s)?`,
      header: 'Confirm',
      icon: 'pi pi-exclamation-triangle',
      accept: () => {
        const ids = this.selectedNotifications().map(n => n.id);
        this.notificationService.deleteMultiple(ids).subscribe({
          next: () => {
            this.selectedNotifications().forEach(n => this.notificationService.delete(n.id));
            this.applyFilters();
            this.selectedNotifications.set([]);
            this.messageService.add({
              severity: 'success',
              summary: 'Deleted',
              detail: `${ids.length} notification(s) removed`,
              life: 2000,
            });
          },
          error: () => {
            this.messageService.add({
              severity: 'error',
              summary: 'Error',
              detail: 'Failed to delete notifications',
              life: 2000,
            });
          },
        });
      },
    });
  }

  markAsRead(notification: AppNotification) {
    this.notificationService.markAsRead(notification.id).subscribe({
      next: () => {
        const updated = this.notificationService.notifications().map(n =>
          n.id === notification.id ? { ...n, read: true } : n
        );
        this.notificationService.notifications.set(updated);
        this.applyFilters();
        this.messageService.add({
          severity: 'info',
          summary: 'Marked',
          detail: 'Notification marked as read',
          life: 2000,
        });
      },
    });
  }

  markSelectedAsRead() {
    if (this.selectedNotifications().length === 0) {
      this.messageService.add({
        severity: 'warn',
        summary: 'No Selection',
        detail: 'Please select notifications to mark',
        life: 2000,
      });
      return;
    }

    const ids = this.selectedNotifications().map(n => n.id);
    this.notificationService.markMultipleAsRead(ids).subscribe({
      next: () => {
        const updated = this.notificationService.notifications().map(n =>
          ids.includes(n.id) ? { ...n, read: true } : n
        );
        this.notificationService.notifications.set(updated);
        this.applyFilters();
        this.selectedNotifications.set([]);
        this.messageService.add({
          severity: 'success',
          summary: 'Marked',
          detail: `${ids.length} notification(s) marked as read`,
          life: 2000,
        });
      },
    });
  }

  clearAllNotifications() {
    this.confirmationService.confirm({
      message: 'Clear all notifications? This action cannot be undone.',
      header: 'Confirm',
      icon: 'pi pi-exclamation-triangle',
      reject: () => {},
      accept: () => {
        this.notificationService.clearAll();
        this.applyFilters();
        this.selectedNotifications.set([]);
        this.messageService.add({
          severity: 'success',
          summary: 'Cleared',
          detail: 'All notifications removed',
          life: 2000,
        });
      },
    });
  }

  exportToCSV() {
    this.notificationService.exportToCSV(this.filteredNotifications());
    this.messageService.add({
      severity: 'success',
      summary: 'Exported',
      detail: 'Notifications exported to CSV',
      life: 2000,
    });
  }

  formatDate(date: Date): string {
    return new Date(date).toLocaleString();
  }

  getReadStatus(read: boolean): string {
    return read ? 'Read' : 'Unread';
  }
}
