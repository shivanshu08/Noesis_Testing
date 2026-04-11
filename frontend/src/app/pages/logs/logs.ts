import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { Router } from '@angular/router';
import { MessageService, ConfirmationService } from 'primeng/api';
import { TableModule } from 'primeng/table';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { DialogModule } from 'primeng/dialog';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { AuthService } from '../../services/auth.service';
import { ExecutionService } from '../../services/execution.service';

interface GlobalLog {
  id: number;
  runId: number | null;
  resultId?: number | null;
  severity: 'error' | 'warn' | 'info' | 'debug';
  message: string;
  summary: string;
  source: string;
  sourceComponent?: string;
  detailedDescription: string;
  context: Record<string, unknown>;
  category?: string;
  runStatus?: string | null;
  timestamp: string;
}

interface FilterOption {
  label: string;
  value: string | number | null;
}

interface PdfColumn {
  header: string;
  width: number;
  value: (log: GlobalLog) => string;
}

@Component({
  selector: 'app-logs',
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
    ToastModule,
    ConfirmDialogModule,
    DialogModule,
    ToggleSwitchModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './logs.html',
  styleUrl: './logs.scss',
})
export class LogsPage implements OnInit, OnDestroy {
  private readonly cacheKey = 'noesis_global_logs_cache_v2';

  allLogs = signal<GlobalLog[]>([]);
  filteredLogs = signal<GlobalLog[]>([]);
  selectedLogs = signal<GlobalLog[]>([]);
  expandedLogIds = signal<Set<number>>(new Set<number>());
  loading = signal(false);
  autoRefresh = signal(false);
  detailsVisible = signal(false);
  selectedLog = signal<GlobalLog | null>(null);
  lastSyncedAt = signal<string | null>(null);

  // Applied filters
  searchTerm = '';
  selectedSeverity: string | null = null;
  selectedRunId: number | null = null;
  startDate = '';
  endDate = '';

  // Draft filters
  draftSearchTerm = '';
  draftSelectedSeverity: string | null = null;
  draftSelectedRunId: number | null = null;
  draftStartDate = '';
  draftEndDate = '';

  rowsPerPage = 10;
  readonly rowsPerPageOptions = [10, 20, 30, 40, 50];

  totalRecords = signal(0);

  severityOptions: FilterOption[] = [
    { label: 'All Severities', value: null },
    { label: 'Error', value: 'error' },
    { label: 'Warning', value: 'warn' },
    { label: 'Info', value: 'info' },
    { label: 'Debug', value: 'debug' },
  ];

  readonly runOptions = computed<FilterOption[]>(() => {
    const map = new Map<number, string>();
    for (const log of this.allLogs()) {
      if (log.runId !== null && !map.has(log.runId)) {
        map.set(log.runId, log.source || `Run #${log.runId}`);
      }
    }

    return [
      { label: 'All Runs', value: null },
      ...Array.from(map.entries())
        .sort((a, b) => b[0] - a[0])
        .map(([id, name]) => ({ label: `${name} (#${id})`, value: id })),
    ];
  });

  readonly totalCount = computed(() => this.allLogs().length);
  readonly errorCount = computed(() => this.allLogs().filter((l) => l.severity === 'error').length);
  readonly warningCount = computed(() => this.allLogs().filter((l) => l.severity === 'warn').length);
  readonly infoCount = computed(() => this.allLogs().filter((l) => l.severity === 'info').length);
  readonly debugCount = computed(() => this.allLogs().filter((l) => l.severity === 'debug').length);
  readonly uniqueRunCount = computed(() => new Set(this.allLogs().filter((l) => l.runId !== null).map((l) => l.runId)).size);

  private readonly destroy$ = new Subject<void>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly executionService: ExecutionService,
    private readonly authService: AuthService,
    private readonly router: Router,
    private readonly messageService: MessageService,
    private readonly confirmationService: ConfirmationService
  ) {}

  ngOnInit(): void {
    this.loadCachedLogs();
    this.fetchLogs(false);
    if (this.autoRefresh()) {
      this.startAutoRefresh();
    }
  }

  ngOnDestroy(): void {
    this.stopAutoRefresh();
    this.destroy$.next();
    this.destroy$.complete();
  }

  fetchLogs(showToast = true): void {
    this.loading.set(true);

    const { fromIso, toIso } = this.getDateRangeIso();
    const requestFilters: {
      from?: string;
      to?: string;
      limit: number;
      offset: number;
    } = {
      limit: 3000,
      offset: 0,
    };

    if (fromIso) requestFilters.from = fromIso;
    if (toIso) requestFilters.to = toIso;

    this.executionService
      .getGlobalLogs(requestFilters)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (response) => {
          const logsData = this.extractLogsArray(response);
          const normalized = logsData.map((log: any) => this.normalizeLog(log));

          this.allLogs.set(normalized);
          this.totalRecords.set(response?.meta?.total ?? normalized.length);
          this.lastSyncedAt.set(new Date().toISOString());
          this.persistLogs(normalized);
          this.expandedLogIds.set(new Set<number>());
          this.applyFilters();

          if (showToast) {
            this.messageService.add({
              severity: 'success',
              summary: 'Logs Refreshed',
              detail: `${normalized.length} records loaded from database`,
            });
          }

          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          const cached = this.readCachedLogs();
          if (cached.length > 0) {
            this.allLogs.set(cached);
            this.applyFilters();
            this.messageService.add({
              severity: 'warn',
              summary: 'Showing Cached Logs',
              detail: 'Could not reach server. Displaying last loaded logs.',
            });
            return;
          }
          this.messageService.add({
            severity: 'error',
            summary: 'Unable to Load Logs',
            detail: 'Could not fetch logs from the server.',
          });
        },
      });
  }

  applyFilters(): void {
    let result = [...this.allLogs()];

    if (this.searchTerm.trim()) {
      const term = this.searchTerm.trim().toLowerCase();
      result = result.filter(
        (log) =>
          log.message.toLowerCase().includes(term) ||
          log.source.toLowerCase().includes(term) ||
          log.detailedDescription.toLowerCase().includes(term) ||
          this.getSeverityLabel(log.severity).toLowerCase().includes(term)
      );
    }

    if (this.selectedSeverity) {
      result = result.filter((log) => log.severity === this.selectedSeverity);
    }

    if (this.selectedRunId !== null) {
      result = result.filter((log) => log.runId === this.selectedRunId);
    }

    result.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    this.filteredLogs.set(result);
  }

  applySelectedFilters(): void {
    const prevStart = this.startDate;
    const prevEnd = this.endDate;

    this.searchTerm = this.draftSearchTerm;
    this.selectedSeverity = this.draftSelectedSeverity;
    this.selectedRunId = this.draftSelectedRunId;
    this.startDate = this.draftStartDate;
    this.endDate = this.draftEndDate;

    const dateChanged = prevStart !== this.startDate || prevEnd !== this.endDate;
    if (dateChanged) {
      this.fetchLogs(false);
      return;
    }

    this.applyFilters();
  }

  isFilterDirty(): boolean {
    return (
      this.draftSearchTerm !== this.searchTerm ||
      this.draftSelectedSeverity !== this.selectedSeverity ||
      this.draftSelectedRunId !== this.selectedRunId ||
      this.draftStartDate !== this.startDate ||
      this.draftEndDate !== this.endDate
    );
  }

  quickApplySeverity(severity: string | null): void {
    this.draftSelectedSeverity = severity;
    this.applySelectedFilters();
  }

  setDateRange(days: number): void {
    const to = new Date();
    const from = new Date();
    from.setDate(to.getDate() - days);

    this.draftStartDate = this.toDateInput(from);
    this.draftEndDate = this.toDateInput(to);
  }

  onAutoRefreshToggle(enabled: boolean): void {
    this.autoRefresh.set(enabled);
    if (enabled) {
      this.startAutoRefresh();
    } else {
      this.stopAutoRefresh();
    }
  }

  toggleRowExpand(log: GlobalLog): void {
    const next = new Set(this.expandedLogIds());
    if (next.has(log.id)) {
      next.delete(log.id);
    } else {
      next.add(log.id);
    }
    this.expandedLogIds.set(next);
  }

  isExpanded(log: GlobalLog): boolean {
    return this.expandedLogIds().has(log.id);
  }

  getContextEntries(log: GlobalLog): Array<[string, string]> {
    return Object.entries(log.context || {}).map(([key, value]) => [key, this.safeString(value)]);
  }

  openDetails(log: GlobalLog): void {
    this.selectedLog.set(log);
    this.detailsVisible.set(true);
  }

  openRun(log: GlobalLog): void {
    if (!log.runId) {
      return;
    }

    this.router.navigate(['/run', log.runId]);
  }

  deleteLog(log: GlobalLog): void {
    if (!this.canEdit()) {
      return;
    }

    this.confirmationService.confirm({
      message: 'Delete this log entry permanently?',
      header: 'Delete Log Entry',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Delete',
      rejectLabel: 'Cancel',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.executionService
          .deleteGlobalLog(log.id)
          .pipe(takeUntil(this.destroy$))
          .subscribe({
            next: () => {
              this.removeLogIds([log.id]);
              this.messageService.add({
                severity: 'success',
                summary: 'Deleted',
                detail: 'Log entry removed.',
              });
            },
            error: () => {
              this.messageService.add({
                severity: 'error',
                summary: 'Delete Failed',
                detail: 'Could not delete this log entry.',
              });
            },
          });
      },
    });
  }

  deleteSelectedLogs(): void {
    if (!this.canEdit() || this.selectedLogs().length === 0) {
      return;
    }

    const ids = this.selectedLogs().map((log) => log.id);
    this.confirmAndDelete(ids, `Delete ${ids.length} selected log(s)?`);
  }

  clearFilteredLogs(): void {
    if (!this.canEdit() || this.filteredLogs().length === 0) {
      return;
    }

    const ids = this.filteredLogs().map((log) => log.id);
    this.confirmAndDelete(ids, `Delete all ${ids.length} filtered log(s)?`);
  }

  clearSelection(): void {
    this.selectedLogs.set([]);
  }

  clearFilters(): void {
    this.searchTerm = '';
    this.selectedSeverity = null;
    this.selectedRunId = null;
    this.startDate = '';
    this.endDate = '';

    this.draftSearchTerm = '';
    this.draftSelectedSeverity = null;
    this.draftSelectedRunId = null;
    this.draftStartDate = '';
    this.draftEndDate = '';

    this.applyFilters();
    this.fetchLogs(false);
  }

  exportToCSV(): void {
    if (this.filteredLogs().length === 0) {
      this.messageService.add({
        severity: 'warn',
        summary: 'No Data',
        detail: 'No logs available to export.',
      });
      return;
    }

    const headers = ['Timestamp', 'Severity', 'Run ID', 'Source', 'Component', 'Message', 'Detailed Description'];
    const rows = this.filteredLogs().map((log) => [
      this.formatDateTime(log.timestamp),
      this.getSeverityLabel(log.severity),
      log.runId ? String(log.runId) : '-',
      log.source,
      log.sourceComponent || '-',
      log.message,
      log.detailedDescription,
    ]);

    const content = [
      headers.join(','),
      ...rows.map((row) => row.map((item) => this.escapeCsv(item)).join(',')),
    ].join('\n');

    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = this.getExportFileName('csv');
    link.click();
    URL.revokeObjectURL(link.href);
  }

  exportToPDF(): void {
    if (this.filteredLogs().length === 0) {
      this.messageService.add({
        severity: 'warn',
        summary: 'No Data',
        detail: 'No logs available to export.',
      });
      return;
    }

    const bytes = this.buildProfessionalPdf(this.filteredLogs());
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const blob = new Blob([buffer], { type: 'application/pdf' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = this.getExportFileName('pdf');
    link.click();
    URL.revokeObjectURL(link.href);
  }

  exportToJSON(): void {
    if (this.filteredLogs().length === 0) {
      return;
    }

    const blob = new Blob([JSON.stringify(this.filteredLogs(), null, 2)], {
      type: 'application/json;charset=utf-8;',
    });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = this.getExportFileName('json');
    link.click();
    URL.revokeObjectURL(link.href);
  }

  copyLogJson(log: GlobalLog): void {
    navigator.clipboard.writeText(JSON.stringify(log, null, 2)).then(() => {
      this.messageService.add({
        severity: 'success',
        summary: 'Copied',
        detail: 'Log JSON copied to clipboard.',
      });
    });
  }

  formatDateTime(timestamp: string): string {
    return new Date(timestamp).toLocaleString('en-US', {
      month: 'short',
      day: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  formatLastSynced(timestamp: string | null): string {
    if (!timestamp) return 'Not synced yet';
    return `Last synced: ${this.formatDateTime(timestamp)}`;
  }

  formatRelativeTime(timestamp: string): string {
    const diffMs = Date.now() - new Date(timestamp).getTime();
    const seconds = Math.floor(diffMs / 1000);

    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  getSeverityTag(severity: string): 'danger' | 'warn' | 'info' | 'secondary' | 'success' | 'contrast' {
    switch (severity) {
      case 'error':
        return 'danger';
      case 'warn':
        return 'warn';
      case 'debug':
        return 'secondary';
      default:
        return 'info';
    }
  }

  getSeverityLabel(severity: string): string {
    switch (severity) {
      case 'error':
        return 'Error';
      case 'warn':
        return 'Warning';
      case 'debug':
        return 'Debug';
      default:
        return 'Info';
    }
  }

  canEdit(): boolean {
    return this.authService.canEdit();
  }

  private confirmAndDelete(ids: number[], message: string): void {
    this.confirmationService.confirm({
      message,
      header: 'Confirm Deletion',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Delete',
      rejectLabel: 'Cancel',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.executionService
          .deleteGlobalLogs(ids)
          .pipe(takeUntil(this.destroy$))
          .subscribe({
            next: () => {
              this.removeLogIds(ids);
              this.selectedLogs.set([]);
              this.messageService.add({
                severity: 'success',
                summary: 'Deleted',
                detail: `${ids.length} log(s) removed.`,
              });
            },
            error: () => {
              this.messageService.add({
                severity: 'error',
                summary: 'Delete Failed',
                detail: 'Could not delete selected logs.',
              });
            },
          });
      },
    });
  }

  private removeLogIds(ids: number[]): void {
    const idSet = new Set(ids);
    this.allLogs.set(this.allLogs().filter((log) => !idSet.has(log.id)));
    this.persistLogs(this.allLogs());

    const expanded = new Set(this.expandedLogIds());
    ids.forEach((id) => expanded.delete(id));
    this.expandedLogIds.set(expanded);

    this.applyFilters();
  }

  private startAutoRefresh(): void {
    this.stopAutoRefresh();
    this.refreshTimer = setInterval(() => {
      if (!this.loading()) {
        this.fetchLogs(false);
      }
    }, 30000);
  }

  private stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private normalizeLog(raw: any): GlobalLog {
    const normalizedSeverity = String(raw?.severity || 'info').toLowerCase();
    const severity =
      normalizedSeverity === 'warning'
        ? 'warn'
        : normalizedSeverity === 'error' || normalizedSeverity === 'warn' || normalizedSeverity === 'debug'
          ? normalizedSeverity
          : 'info';

    const parsedId = Number(raw?.id);

    return {
      id: Number.isFinite(parsedId) ? parsedId : Date.now() + Math.floor(Math.random() * 1000),
      runId: raw?.runId ? Number(raw.runId) : null,
      resultId: raw?.resultId ? Number(raw.resultId) : null,
      severity,
      message: String(raw?.message || raw?.detail || ''),
      summary: String(raw?.summary || raw?.message || raw?.detail || ''),
      source: String(raw?.source || 'Execution'),
      sourceComponent: raw?.sourceComponent ? String(raw.sourceComponent) : 'execution-engine',
      detailedDescription: String(raw?.detailedDescription || raw?.detailed_description || raw?.detail || raw?.message || ''),
      context: this.parseContext(raw?.context || raw?.logContext),
      category: raw?.category ? String(raw.category) : undefined,
      runStatus: raw?.runStatus ? String(raw.runStatus) : null,
      timestamp: raw?.time || raw?.timestamp || new Date().toISOString(),
    };
  }

  private parseContext(context: unknown): Record<string, unknown> {
    if (!context) return {};

    if (typeof context === 'string') {
      try {
        const parsed = JSON.parse(context);
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    }

    return typeof context === 'object' ? (context as Record<string, unknown>) : {};
  }

  private extractLogsArray(response: any): any[] {
    if (Array.isArray(response)) return response;
    if (Array.isArray(response?.data)) return response.data;
    if (Array.isArray(response?.logs)) return response.logs;
    if (Array.isArray(response?.items)) return response.items;
    return [];
  }

  private getDateRangeIso(): { fromIso?: string; toIso?: string } {
    let fromIso: string | undefined;
    let toIso: string | undefined;

    if (this.startDate) {
      const from = new Date(this.startDate);
      from.setHours(0, 0, 0, 0);
      fromIso = from.toISOString();
    }

    if (this.endDate) {
      const to = new Date(this.endDate);
      to.setHours(23, 59, 59, 999);
      toIso = to.toISOString();
    }

    return { fromIso, toIso };
  }

  private toDateInput(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  private escapeCsv(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  private loadCachedLogs(): void {
    const cached = this.readCachedLogs();
    if (cached.length === 0) return;

    this.allLogs.set(cached);
    this.totalRecords.set(cached.length);
    this.applyFilters();
  }

  private persistLogs(logs: GlobalLog[]): void {
    try {
      localStorage.setItem(this.cacheKey, JSON.stringify(logs));
    } catch {
      // Ignore cache write failures
    }
  }

  private readCachedLogs(): GlobalLog[] {
    try {
      const raw = localStorage.getItem(this.cacheKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((item: any) => this.normalizeLog(item));
    } catch {
      return [];
    }
  }

  private getExportFileName(extension: 'csv' | 'pdf' | 'json'): string {
    const now = new Date();
    const p = (n: number): string => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
    return `Noesis_Testing_Logs_${stamp}.${extension}`;
  }

  private buildProfessionalPdf(logs: GlobalLog[]): Uint8Array {
    const pageWidth = 842;
    const pageHeight = 595;
    const margin = 24;

    const columns: PdfColumn[] = [
      { header: 'Timestamp', width: 132, value: (log) => this.formatDateTime(log.timestamp) },
      { header: 'Level', width: 60, value: (log) => this.getSeverityLabel(log.severity) },
      { header: 'Run', width: 50, value: (log) => (log.runId ? String(log.runId) : '-') },
      { header: 'Source', width: 140, value: (log) => log.source },
      { header: 'Component', width: 95, value: (log) => log.sourceComponent || '-' },
      { header: 'Description', width: 317, value: (log) => log.detailedDescription || log.message },
    ];

    const headerHeight = 22;
    const rowHeight = 18;
    const tableTop = 514;
    const bottomSafe = 34;
    const rowsPerPage = Math.max(1, Math.floor((tableTop - headerHeight - bottomSafe) / rowHeight));

    const totalPages = Math.max(1, Math.ceil(logs.length / rowsPerPage));
    const pageStreams: string[] = [];

    for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
      const start = pageIndex * rowsPerPage;
      const end = start + rowsPerPage;
      const pageLogs = logs.slice(start, end);
      const commands: string[] = [];

      commands.push(this.pdfText('F2', 17, margin, 560, 'Noesis Testing Logs'));
      commands.push(this.pdfText('F1', 10, margin, 545, `Generated: ${this.formatDateTime(new Date().toISOString())}`));
      commands.push(this.pdfText('F1', 10, margin + 360, 545, `Total Logs: ${logs.length}`));
      commands.push(this.pdfText('F1', 10, pageWidth - 120, 545, `Page ${pageIndex + 1}/${totalPages}`));

      let x = margin;
      const headerY = tableTop - headerHeight;
      for (const col of columns) {
        commands.push(this.pdfFilledRect(x, headerY, col.width, headerHeight, [0.52, 0.78, 0.9]));
        commands.push(this.pdfRectStroke(x, headerY, col.width, headerHeight));
        commands.push(this.pdfText('F2', 8.5, x + 4, headerY + 7, this.truncatePdfText(col.header, col.width - 8, 8.5)));
        x += col.width;
      }

      let currentY = headerY - rowHeight;
      for (const log of pageLogs) {
        x = margin;
        for (const col of columns) {
          commands.push(this.pdfRectStroke(x, currentY, col.width, rowHeight));
          const textValue = this.truncatePdfText(col.value(log), col.width - 8, 8);
          commands.push(this.pdfText('F1', 8, x + 4, currentY + 6, textValue));
          x += col.width;
        }
        currentY -= rowHeight;
      }

      pageStreams.push(commands.join('\n'));
    }

    return this.composePdf(pageStreams, pageWidth, pageHeight);
  }

  private composePdf(pageStreams: string[], pageWidth: number, pageHeight: number): Uint8Array {
    const objects = new Map<number, string>();
    const catalogId = 1;
    const pagesId = 2;
    const fontRegularId = 3;
    const fontBoldId = 4;

    let nextId = 5;
    const pageIds: number[] = [];
    const contentIds: number[] = [];

    for (let i = 0; i < pageStreams.length; i++) {
      const pageId = nextId++;
      const contentId = nextId++;
      pageIds.push(pageId);
      contentIds.push(contentId);
    }

    objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    objects.set(
      pagesId,
      `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`
    );
    objects.set(fontRegularId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    objects.set(fontBoldId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

    for (let i = 0; i < pageStreams.length; i++) {
      const pageId = pageIds[i];
      const contentId = contentIds[i];
      const stream = pageStreams[i];

      objects.set(
        pageId,
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${contentId} 0 R >>`
      );
      objects.set(contentId, `<< /Length ${this.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    }

    const maxId = nextId - 1;
    let pdf = '%PDF-1.4\n';
    const offsets: number[] = new Array(maxId + 1).fill(0);

    for (let id = 1; id <= maxId; id++) {
      offsets[id] = this.byteLength(pdf);
      const body = objects.get(id) || '';
      pdf += `${id} 0 obj\n${body}\nendobj\n`;
    }

    const xrefStart = this.byteLength(pdf);
    pdf += `xref\n0 ${maxId + 1}\n`;
    pdf += '0000000000 65535 f \n';

    for (let id = 1; id <= maxId; id++) {
      pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    }

    pdf += `trailer\n<< /Size ${maxId + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
    return new TextEncoder().encode(pdf);
  }

  private pdfText(font: 'F1' | 'F2', size: number, x: number, y: number, text: string): string {
    return `BT /${font} ${size} Tf 0.16 0.2 0.24 rg 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${this.escapePdf(text)}) Tj ET`;
  }

  private pdfRectStroke(x: number, y: number, w: number, h: number): string {
    return `0.72 0.77 0.84 RG 0.5 w ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S`;
  }

  private pdfFilledRect(x: number, y: number, w: number, h: number, rgb: [number, number, number]): string {
    return `${rgb[0].toFixed(2)} ${rgb[1].toFixed(2)} ${rgb[2].toFixed(2)} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`;
  }

  private truncatePdfText(text: string, width: number, fontSize: number): string {
    const clean = this.toAscii(text).replace(/\s+/g, ' ').trim();
    if (!clean) return '-';

    const charWidth = fontSize * 0.52;
    const maxChars = Math.max(1, Math.floor(width / charWidth));
    if (clean.length <= maxChars) return clean;
    if (maxChars <= 3) return clean.slice(0, maxChars);
    return `${clean.slice(0, maxChars - 3)}...`;
  }

  private safeString(value: unknown): string {
    if (value === null || value === undefined) return '-';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return '-';
    }
  }

  private toAscii(value: string): string {
    return value.normalize('NFKD').replace(/[^\x20-\x7E]/g, '?');
  }

  private escapePdf(value: string): string {
    return this.toAscii(value)
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)');
  }

  private byteLength(value: string): number {
    return new TextEncoder().encode(value).length;
  }
}
