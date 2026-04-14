import { Component, OnDestroy, OnInit, computed, signal, NO_ERRORS_SCHEMA } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
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
import { DialogModule } from 'primeng/dialog';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { AuthService } from '../../services/auth.service';
import { ExecutionService } from '../../services/execution.service';
import { AlertOverlayComponent } from '../../components/alert-overlay/alert-overlay';

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
  action?: string;
  status?: string | null;
  module?: string;
  scriptName?: string | null;
  timestamp: string;
  time?: string;
  detail?: string;
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

interface LogsLocaleConfig {
  dropdowns?: {
    allSeverities?: string;
    allRuns?: string;
    allModules?: string;
    allActions?: string;
    severities?: Record<string, string>;
    modules?: Record<string, string>;
    actions?: Record<string, string>;
  };
}

interface LogsLocaleResolved {
  dropdowns: {
    allSeverities: string;
    allRuns: string;
    allModules: string;
    allActions: string;
    severities: Record<string, string>;
    modules: Record<string, string>;
    actions: Record<string, string>;
  };
}

const DEFAULT_LOGS_LOCALE: LogsLocaleResolved = {
  dropdowns: {
    allSeverities: 'All Severities',
    allRuns: 'All Runs',
    allModules: 'All Modules',
    allActions: 'All Actions',
    severities: {
      error: 'Error',
      warn: 'Warning',
      info: 'Info',
      debug: 'Debug',
    },
    modules: {
      system: 'System',
      auth: 'Authentication',
      scripts: 'Scripts',
      execution: 'Execution',
      suites: 'Suites',
      users: 'Users',
      notifications: 'Notifications',
      application: 'Application',
      'application-api': 'Application API',
      'execution-engine': 'Execution Engine',
    },
    actions: {
      AUTH_LOGIN: 'User Login',
      AUTH_FORGOT_PASSWORD: 'Forgot Password',
      AUTH_CHANGE_PASSWORD: 'Change Password',
      EXECUTION_START: 'Execution Started',
      EXECUTION_STOP: 'Execution Stopped',
      SUITES_CREATE: 'Suite Created',
      SUITES_UPDATE: 'Suite Updated',
      SUITES_DELETE: 'Suite Deleted',
      SCRIPT_IMPORT: 'Script Imported',
      SCRIPT_IMPORT_DUPLICATE: 'Duplicate Script Import',
      SCRIPT_IMPORT_REJECTED: 'Script Import Rejected',
      SCRIPT_DELETE: 'Script Deleted',
      SCRIPT_BULK_DELETE: 'Scripts Deleted',
      WORKSPACE_SYNC: 'Workspace Synced',
      SCRIPTS_READ: 'Scripts Viewed',
      SCRIPTS_CREATE: 'Script Created',
      SCRIPTS_UPDATE: 'Script Updated',
      SCRIPTS_DELETE: 'Script Deleted',
      SCRIPTS_BULK_DELETE: 'Scripts Deleted',
      EXECUTION_READ: 'Execution Viewed',
      USERS_READ: 'Users Viewed',
      SUITES_READ: 'Suites Viewed',
      LOGS_READ: 'Logs Viewed',
      SYSTEM_START: 'System Started',
      SYSTEM_DB_READY: 'Database Ready',
    },
  },
};

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
    DialogModule,
    ToggleSwitchModule,
    AlertOverlayComponent,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './logs.html',
  styleUrl: './logs.scss',
  schemas: [NO_ERRORS_SCHEMA],
})
export class LogsPage implements OnInit, OnDestroy {
  private readonly cacheKey = 'noesis_global_logs_cache_v2';
  private locale: LogsLocaleResolved = DEFAULT_LOGS_LOCALE;

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
  selectedModule: string | null = null;
  selectedAction: string | null = null;
  dateFrom = '';
  dateTo = '';

  // Draft filters
  draftSearchTerm = '';
  draftSelectedSeverity: string | null = null;
  draftSelectedRunId: number | null = null;
  draftSelectedModule: string | null = null;
  draftSelectedAction: string | null = null;
  draftDateFrom = '';
  draftDateTo = '';

  firstRow = signal(0);
  rowsPerPage = 10;
  readonly rowsPerPageOptions = [10, 20, 30, 40, 50];
  private sortBy: string = 'timestamp';
  private sortOrder: 'asc' | 'desc' = 'desc';

  totalRecords = signal(0);

  severityOptions: FilterOption[] = [];

  expandedRows: { [key: string]: boolean } = {};
  moduleOptions: FilterOption[] = [];
  actionOptions: FilterOption[] = [];

  readonly runOptions = computed<FilterOption[]>(() => {
    const ids = new Set<number>();
    for (const log of this.allLogs()) {
      if (log.runId !== null) {
        ids.add(log.runId);
      }
    }

    return [
      { label: this.locale.dropdowns.allRuns || 'All Runs', value: null },
      ...Array.from(ids.values())
        .sort((a, b) => b - a)
        .map((id) => ({ label: `Run #${id}`, value: id })),
    ];
  });

  errorCount = signal(0);
  warningCount = signal(0);
  infoCount = signal(0);
  debugCount = signal(0);
  uniqueRunCount = signal(0);

  readonly hasActiveFilters = computed(() => {
    return !!(
      this.searchTerm.trim() ||
      this.selectedSeverity ||
      this.selectedRunId !== null ||
      this.selectedModule ||
      this.selectedAction ||
      this.dateFrom ||
      this.dateTo
    );
  });

  readonly activeFilterChips = computed(() => {
    const chips: Array<{ key: string; label: string; value: any }> = [];
    if (this.searchTerm.trim()) chips.push({ key: 'q', label: 'Search', value: this.searchTerm });
    if (this.selectedSeverity) {
      const label = this.locale.dropdowns.severities[this.selectedSeverity] || this.selectedSeverity;
      chips.push({ key: 'severity', label: 'Severity', value: label });
    }
    if (this.selectedRunId !== null) chips.push({ key: 'runId', label: 'Run', value: `#${this.selectedRunId}` });
    if (this.selectedModule) chips.push({ key: 'module', label: 'Module', value: this.selectedModule });
    if (this.selectedAction) chips.push({ key: 'action', label: 'Action', value: this.selectedAction });
    if (this.dateFrom) chips.push({ key: 'dateFrom', label: 'From', value: this.formatDisplayDate(this.dateFrom) });
    if (this.dateTo) chips.push({ key: 'dateTo', label: 'To', value: this.formatDisplayDate(this.dateTo) });
    return chips;
  });

  private formatDisplayDate(isoDate: string | null | undefined): string {
    if (!isoDate) return '-';
    const parts = String(isoDate).split('-');
    if (parts.length === 3) {
      return `${parts[2]}-${parts[1]}-${parts[0]}`; // dd-mm-yyyy
    }
    return String(isoDate);
  }

  private readonly destroy$ = new Subject<void>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly http: HttpClient,
    private readonly executionService: ExecutionService,
    private readonly authService: AuthService,
    private readonly router: Router,
    private readonly messageService: MessageService,
    private readonly confirmationService: ConfirmationService
  ) {}

  ngOnInit(): void {
    this.applyLocale(DEFAULT_LOGS_LOCALE);
    this.loadLocaleConfig();
    this.setDefaultDateRange();
    this.loadCachedLogs();
    this.loadFilterDropdowns();
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

  private loadLocaleConfig(): void {
    this.http
      .get<{ logs?: LogsLocaleConfig }>('/i18n/en.json')
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (payload) => {
          this.applyLocale(payload?.logs || DEFAULT_LOGS_LOCALE);
          this.loadFilterDropdowns();
        },
        error: () => {
          this.applyLocale(DEFAULT_LOGS_LOCALE);
        },
      });
  }

  private applyLocale(locale: LogsLocaleConfig): void {
    const dropdowns: LogsLocaleResolved['dropdowns'] = {
      ...DEFAULT_LOGS_LOCALE.dropdowns,
      ...(locale.dropdowns || {}),
      severities: {
        ...DEFAULT_LOGS_LOCALE.dropdowns.severities,
        ...(locale.dropdowns?.severities || {}),
      },
      modules: {
        ...DEFAULT_LOGS_LOCALE.dropdowns.modules,
        ...(locale.dropdowns?.modules || {}),
      },
      actions: {
        ...DEFAULT_LOGS_LOCALE.dropdowns.actions,
        ...(locale.dropdowns?.actions || {}),
      },
    };

    this.locale = { dropdowns };

    this.severityOptions = [
      { label: dropdowns.allSeverities, value: null },
      { label: dropdowns.severities['error'] || 'Error', value: 'error' },
      { label: dropdowns.severities['warn'] || 'Warning', value: 'warn' },
      { label: dropdowns.severities['info'] || 'Info', value: 'info' },
      { label: dropdowns.severities['debug'] || 'Debug', value: 'debug' },
    ];

    if (this.moduleOptions.length === 0) {
      this.moduleOptions = [{ label: dropdowns.allModules, value: null }];
    } else {
      this.moduleOptions = [
        { label: dropdowns.allModules, value: null },
        ...this.moduleOptions.filter((option) => option.value !== null),
      ];
    }

    if (this.actionOptions.length === 0) {
      this.actionOptions = [{ label: dropdowns.allActions, value: null }];
    } else {
      this.actionOptions = [
        { label: dropdowns.allActions, value: null },
        ...this.actionOptions.filter((option) => option.value !== null),
      ];
    }
  }

  fetchLogs(showToast = true): void {
    this.loading.set(true);

    const { fromIso, toIso } = this.getDateRangeIso();
    const requestFilters: {
      q?: string;
      severity?: string;
      runId?: number;
      module?: string;
      action?: string;
      from?: string;
      to?: string;
      sortBy: string;
      sortOrder: 'asc' | 'desc';
      limit: number;
      offset: number;
    } = {
      sortBy: this.sortBy,
      sortOrder: this.sortOrder,
      limit: this.rowsPerPage,
      offset: this.firstRow(),
    };

    if (this.searchTerm.trim()) requestFilters.q = this.searchTerm.trim();
    if (this.selectedSeverity) requestFilters.severity = this.selectedSeverity;
    if (this.selectedRunId !== null) requestFilters.runId = this.selectedRunId;
    if (this.selectedModule) requestFilters.module = this.selectedModule;
    if (this.selectedAction) requestFilters.action = this.selectedAction;
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

          if (response?.summary) {
            this.errorCount.set(response.summary.errorCount || 0);
            this.warningCount.set(response.summary.warnCount || 0);
            this.infoCount.set(response.summary.infoCount || 0);
            this.debugCount.set(response.summary.debugCount || 0);
            this.uniqueRunCount.set(response.summary.uniqueRunCount || 0);
          }

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
        error: (err) => {
          this.loading.set(false);
          const status = Number(err?.status || 0);
          const cached = this.readCachedLogs();
          if (cached.length > 0 && status === 0) {
            this.allLogs.set(cached);
            this.applyFilters();
            this.messageService.add({
              severity: 'warn',
              summary: 'Showing Cached Logs',
              detail: 'Server is unreachable. Displaying last loaded logs.',
            });
            return;
          }
          this.messageService.add({
            severity: 'error',
            summary: 'Unable to Load Logs',
            detail: status === 0
              ? 'Could not reach server.'
              : 'Failed to fetch logs from server.',
          });
        },
      });
  }

  applyFilters(): void {
    // Backend now handles all filtering and sorting.
    // We just set filteredLogs to match allLogs (the current page).
    this.filteredLogs.set([...this.allLogs()]);
  }

  applySelectedFilters(): void {
    this.searchTerm = this.draftSearchTerm;
    this.selectedSeverity = this.draftSelectedSeverity;
    this.selectedRunId = this.draftSelectedRunId;
    this.selectedModule = this.draftSelectedModule;
    this.selectedAction = this.draftSelectedAction;
    this.dateFrom = this.draftDateFrom;
    this.dateTo = this.draftDateTo;
    this.firstRow.set(0);
    this.loadFilterDropdowns();
    this.fetchLogs(false);
  }

  isFilterDirty(): boolean {
    return (
      this.draftSearchTerm !== this.searchTerm ||
      this.draftSelectedSeverity !== this.selectedSeverity ||
      this.draftSelectedRunId !== this.selectedRunId ||
      this.draftSelectedModule !== this.selectedModule ||
      this.draftSelectedAction !== this.selectedAction ||
      this.draftDateFrom !== this.dateFrom ||
      this.draftDateTo !== this.dateTo
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

    this.draftDateFrom = this.toDateInput(from);
    this.draftDateTo = this.toDateInput(to);
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
      icon: 'pi pi-trash',
      acceptLabel: 'Delete',
      rejectLabel: 'Cancel',
      acceptIcon: 'pi pi-trash',
      rejectIcon: 'pi pi-times',
      defaultFocus: 'reject',
      acceptButtonStyleClass: 'p-button-sm p-button-danger',
      rejectButtonStyleClass: 'p-button-sm p-button-text p-button-secondary',
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

  deleteSelected(): void {
    this.deleteSelectedLogs();
  }

  clearSelection(): void {
    this.selectedLogs.set([]);
  }

  toggleLogSelection(log: GlobalLog): void {
    const current = this.selectedLogs();
    if (current.some(l => l.id === log.id)) {
      this.selectedLogs.set(current.filter(l => l.id !== log.id));
    } else {
      this.selectedLogs.set([...current, log]);
    }
  }

  clearFilters(): void {
    this.searchTerm = '';
    this.selectedSeverity = null;
    this.selectedRunId = null;
    this.selectedModule = null;
    this.selectedAction = null;
    this.setDefaultDateRange();
    this.firstRow.set(0);
    this.sortBy = 'timestamp';
    this.sortOrder = 'desc';

    this.draftSearchTerm = '';
    this.draftSelectedSeverity = null;
    this.draftSelectedRunId = null;
    this.draftSelectedModule = null;
    this.draftSelectedAction = null;
    this.draftDateFrom = this.dateFrom;
    this.draftDateTo = this.dateTo;

    this.applyFilters();
    this.loadFilterDropdowns();
    this.fetchLogs(false);
  }

  removeActiveFilter(key: string): void {
    if (key === 'q') { this.searchTerm = ''; this.draftSearchTerm = ''; }
    if (key === 'severity') { this.selectedSeverity = null; this.draftSelectedSeverity = null; }
    if (key === 'runId') { this.selectedRunId = null; this.draftSelectedRunId = null; }
    if (key === 'module') { this.selectedModule = null; this.draftSelectedModule = null; }
    if (key === 'action') { this.selectedAction = null; this.draftSelectedAction = null; }
    if (key === 'dateFrom') { this.dateFrom = ''; this.draftDateFrom = ''; }
    if (key === 'dateTo') { this.dateTo = ''; this.draftDateTo = ''; }

    this.firstRow.set(0);
    this.applyFilters();
    this.fetchLogs(true);
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

  formatDate(timestamp: string): string {
    return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
  }

  formatTime(timestamp: string): string {
    return new Date(timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

  getMessagePreview(message: string): string {
    const normalized = String(message || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '-';
    const maxLength = 72;
    return normalized.length <= maxLength
      ? normalized
      : `${normalized.substring(0, maxLength - 3)}...`;
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
    const key = String(severity || 'info').toLowerCase();
    return this.locale.dropdowns.severities[key] || this.toTitleWords(key);
  }

  getSeverityIcon(severity: string): string {
    switch (severity) {
      case 'error':
        return 'pi pi-bug'; // Modern tech error representation
      case 'warn':
        return 'pi pi-exclamation-triangle'; // Universal warning symbol
      case 'debug':
        return 'pi pi-cog'; // Classic debug representation
      default:
        return 'pi pi-align-left'; // Represents textual log data
    }
  }

  getScriptNameLabel(log: GlobalLog): string {
    const name = String(log.scriptName || '').trim();
    return name ? name : '-';
  }

  getStatusLabel(log: GlobalLog): string {
    const raw = String(log.runStatus || log.status || '').trim();
    if (!raw) return '-';
    return this.toTitleWords(raw.replace(/[_-]+/g, ' '));
  }

  getActionLabelForLog(log: GlobalLog): string {
    return this.getActionLabel(log.action || null);
  }

  getActorLabel(log: GlobalLog): string {
    const username = String(log.context?.['username'] || '').trim();
    if (username) return username;

    const userIdRaw = log.context?.['userId'];
    const userId = typeof userIdRaw === 'number' ? userIdRaw : Number(userIdRaw);
    if (Number.isFinite(userId) && userId > 0) {
      return `User ${Math.trunc(userId)}`;
    }

    return '-';
  }

  getHttpMethodLabel(log: GlobalLog): string {
    const raw = String(log.context?.['httpMethod'] || '').trim();
    return raw ? raw.toUpperCase() : '-';
  }

  getHttpPathLabel(log: GlobalLog): string {
    const raw = String(log.context?.['httpPath'] || '').trim();
    return raw || '-';
  }

  getRequestIdLabel(log: GlobalLog): string {
    const raw = String(log.context?.['requestId'] || '').trim();
    return raw || '-';
  }

  getAuditSummary(log: GlobalLog): string {
    const metadata = this.getAuditMetadata(log);
    if (!metadata) return '-';

    const changedPartsRaw = metadata['changedParts'];
    if (Array.isArray(changedPartsRaw)) {
      const changedParts = changedPartsRaw
        .map((part) => String(part || '').trim())
        .filter(Boolean);
      if (changedParts.length > 0) {
        return `Changed: ${changedParts.join(', ')}`;
      }
    }

    const operation = String(metadata['operation'] || '').trim();
    if (operation) {
      return `Operation: ${operation}`;
    }

    const scriptCount = Number(metadata['scriptCount']);
    if (Number.isFinite(scriptCount)) {
      return `Scripts: ${scriptCount}`;
    }

    return '-';
  }

  getAuditMetadataJson(log: GlobalLog): string {
    const metadata = this.getAuditMetadata(log);
    if (!metadata) return '-';
    try {
      return JSON.stringify(metadata, null, 2);
    } catch {
      return '-';
    }
  }

  private getAuditMetadata(log: GlobalLog): Record<string, unknown> | null {
    const metadata = log.context?.['metadata'];
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }
    return metadata as Record<string, unknown>;
  }

  hasValue(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === 'number') return Number.isFinite(value);
    const normalized = String(value).trim();
    return normalized.length > 0 && normalized !== '-';
  }

  canEdit(): boolean {
    return this.authService.canEdit();
  }

  private confirmAndDelete(ids: number[], message: string): void {
    this.confirmationService.confirm({
      message,
      header: 'Confirm Deletion',
      icon: 'pi pi-trash',
      acceptLabel: 'Delete',
      rejectLabel: 'Cancel',
      acceptIcon: 'pi pi-trash',
      rejectIcon: 'pi pi-times',
      defaultFocus: 'reject',
      acceptButtonStyleClass: 'p-button-sm p-button-danger',
      rejectButtonStyleClass: 'p-button-sm p-button-text p-button-secondary',
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

    const timestamp = raw?.time || raw?.timestamp || new Date().toISOString();
    const rawDetailedDescription = String(raw?.detailedDescription || raw?.detailed_description || raw?.detail || raw?.message || '');
    const context = this.parseContext(raw?.context || raw?.logContext);
    const actionRaw = String(raw?.action || context['action'] || '').trim().toUpperCase();
    const action = this.normalizeActionCode(actionRaw);
    const statusRaw = String(raw?.status || context['status'] || raw?.runStatus || '').trim().toUpperCase();
    const moduleRaw = String(raw?.sourceComponent || context['module'] || raw?.source || '').trim();
    const rawMessage = String(raw?.message || raw?.detail || rawDetailedDescription || '');
    const scriptName = this.extractScriptName(action, rawMessage, context);
    const logicalMessage = this.toLogicalMessage({
      action: action || undefined,
      status: statusRaw || undefined,
      rawMessage,
      context,
      scriptName: scriptName || undefined,
    });
    const detailDesc = this.sanitizeTechnicalMessage(rawDetailedDescription || rawMessage);

    const parsedId = Number(raw?.id);

    return {
      id: Number.isFinite(parsedId) ? parsedId : Date.now() + Math.floor(Math.random() * 1000),
      runId: raw?.runId ? Number(raw.runId) : null,
      resultId: raw?.resultId ? Number(raw.runId) : null,
      severity,
      message: logicalMessage,
      summary: logicalMessage,
      source: String(raw?.source || 'Execution'),
      sourceComponent: raw?.sourceComponent ? String(raw.sourceComponent) : 'execution-engine',
      detailedDescription: detailDesc,
      context,
      category: raw?.category ? String(raw.category) : undefined,
      runStatus: raw?.runStatus ? String(raw.runStatus) : null,
      action: action || undefined,
      status: statusRaw || null,
      module: moduleRaw || undefined,
      scriptName: scriptName || null,
      timestamp: timestamp,
      time: timestamp,
      detail: detailDesc,
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

    if (this.dateFrom) {
      const from = this.parseDateInput(this.dateFrom);
      if (from) {
      from.setHours(0, 0, 0, 0);
      fromIso = from.toISOString();
      }
    }

    if (this.dateTo) {
      const to = this.parseDateInput(this.dateTo);
      if (to) {
      to.setHours(23, 59, 59, 999);
      toIso = to.toISOString();
      }
    }

    return { fromIso, toIso };
  }

  private getDateBoundaryMs(value: string, boundary: 'start' | 'end'): number | null {
    const date = this.parseDateInput(value);
    if (!date) return null;
    if (boundary === 'start') {
      date.setHours(0, 0, 0, 0);
    } else {
      date.setHours(23, 59, 59, 999);
    }
    return date.getTime();
  }

  private parseDateInput(value: string): Date | null {
    const raw = String(value || '').trim();
    if (!raw) return null;

    const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
      const year = Number(isoMatch[1]);
      const month = Number(isoMatch[2]) - 1;
      const day = Number(isoMatch[3]);
      return new Date(year, month, day);
    }

    const dmyMatch = raw.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
    if (dmyMatch) {
      const day = Number(dmyMatch[1]);
      const month = Number(dmyMatch[2]) - 1;
      const year = Number(dmyMatch[3]);
      return new Date(year, month, day);
    }

    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
  }

  private toDateInput(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  private setDefaultDateRange(): void {
    const today = new Date();
    const rangeStr = this.toDateInput(today);

    this.dateFrom = rangeStr;
    this.dateTo = rangeStr;
    this.draftDateFrom = rangeStr;
    this.draftDateTo = rangeStr;
  }

  onLazyLoad(event: any): void {
    const nextFirst = Number(event?.first ?? 0);
    const nextRows = Number(event?.rows ?? this.rowsPerPage);

    this.firstRow.set(Number.isFinite(nextFirst) ? Math.max(nextFirst, 0) : 0);
    this.rowsPerPage = Number.isFinite(nextRows) && nextRows > 0 ? nextRows : this.rowsPerPage;
    this.sortBy = this.mapSortField(String(event?.sortField || 'timestamp'));
    this.sortOrder = event?.sortOrder === 1 ? 'asc' : 'desc';

    this.fetchLogs(false);
  }

  onModuleDraftChange(): void {
    this.draftSelectedAction = null;
    this.loadActionOptions(this.draftSelectedModule || undefined);
  }

  private mapSortField(field: string): string {
    const allowed = new Set(['timestamp', 'severity', 'source', 'action', 'status', 'runId', 'resultId']);
    return allowed.has(field) ? field : 'timestamp';
  }

  private loadFilterDropdowns(): void {
    this.loadModuleOptions();
    this.loadActionOptions(this.draftSelectedModule || this.selectedModule || undefined);
  }

  private loadModuleOptions(): void {
    const { fromIso, toIso } = this.getDateRangeIso();
    this.executionService
      .getLogModules({ from: fromIso, to: toIso })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (items) => {
          this.moduleOptions = [
            { label: this.locale.dropdowns.allModules || 'All Modules', value: null },
            ...items.map((item) => ({ label: this.getModuleLabel(item.value), value: item.value })),
          ];
        },
        error: () => {
          this.moduleOptions = [{ label: this.locale.dropdowns.allModules || 'All Modules', value: null }];
        },
      });
  }

  private loadActionOptions(module?: string): void {
    const { fromIso, toIso } = this.getDateRangeIso();
    this.executionService
      .getLogActions({ from: fromIso, to: toIso, module })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (items) => {
          const uniqueByCanonical = new Map<string, FilterOption>();
          for (const item of items) {
            const value = String(item.value || '').trim();
            if (!value) continue;
            const canonical = this.normalizeActionCode(value);
            if (!uniqueByCanonical.has(canonical)) {
              uniqueByCanonical.set(canonical, {
                label: this.getActionLabel(canonical),
                value: canonical,
              });
            }
          }

          this.actionOptions = [
            { label: this.locale.dropdowns.allActions || 'All Actions', value: null },
            ...Array.from(uniqueByCanonical.values()).sort((a, b) => a.label.localeCompare(b.label)),
          ];
        },
        error: () => {
          this.actionOptions = [{ label: this.locale.dropdowns.allActions || 'All Actions', value: null }];
        },
      });
  }

  private getActionLabel(action: string | null | undefined): string {
    const normalized = this.normalizeActionCode(action);
    if (!normalized) return '-';

    const configured = this.locale.dropdowns.actions[normalized];
    if (configured) return configured;

    return this.humanizeAction(normalized);
  }

  private humanizeAction(action: string): string {
    const cleaned = action.replace(/\s+/g, '_').replace(/-+/g, '_').toUpperCase();

    if (cleaned.endsWith('_BULK_DELETE')) {
      return `${this.toTitleWords(cleaned.replace(/_BULK_DELETE$/, ''))} Bulk Deleted`;
    }
    if (cleaned.endsWith('_DELETE')) {
      return `${this.toTitleWords(cleaned.replace(/_DELETE$/, ''))} Deleted`;
    }
    if (cleaned.endsWith('_UPDATE')) {
      return `${this.toTitleWords(cleaned.replace(/_UPDATE$/, ''))} Updated`;
    }
    if (cleaned.endsWith('_CREATE')) {
      return `${this.toTitleWords(cleaned.replace(/_CREATE$/, ''))} Created`;
    }
    if (cleaned.endsWith('_READ')) {
      return `${this.toTitleWords(cleaned.replace(/_READ$/, ''))} Viewed`;
    }
    if (cleaned.endsWith('_IMPORT')) {
      return `${this.toTitleWords(cleaned.replace(/_IMPORT$/, ''))} Imported`;
    }
    if (cleaned.endsWith('_SYNC')) {
      return `${this.toTitleWords(cleaned.replace(/_SYNC$/, ''))} Synced`;
    }

    return this.toTitleWords(cleaned);
  }

  private normalizeActionCode(action: string | null | undefined): string {
    const normalized = String(action || '').trim().toUpperCase();
    if (!normalized) return '';

    const aliases: Record<string, string> = {
      SCRIPTS_DELETE: 'SCRIPT_DELETE',
      SCRIPTS_UPDATE: 'SCRIPT_UPDATE',
      SCRIPTS_CREATE: 'SCRIPT_CREATE',
      SCRIPTS_BULK_DELETE: 'SCRIPT_DELETE',
      SCRIPT_BULK_DELETE: 'SCRIPT_DELETE',
    };

    return aliases[normalized] || normalized;
  }

  private getModuleLabel(moduleValue: string | null | undefined): string {
    const normalized = String(moduleValue || '').trim().toLowerCase();
    if (!normalized) return '-';

    const configured = this.locale.dropdowns.modules[normalized];
    if (configured) return configured;

    return this.toTitleWords(normalized.replace(/[^a-z0-9]+/gi, ' '));
  }

  private toTitleWords(input: string): string {
    return String(input || '')
      .split(/[\s_]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.substring(1).toLowerCase())
      .join(' ');
  }

  private toLogicalMessage(params: {
    action?: string;
    status?: string;
    rawMessage: string;
    context: Record<string, unknown>;
    scriptName?: string;
  }): string {
    const action = (params.action || '').toUpperCase();
    const status = (params.status || '').toUpperCase();
    const rawMessage = String(params.rawMessage || '').trim();

    if (!action) {
      return this.sanitizeTechnicalMessage(rawMessage);
    }

    const metadata = (params.context?.['metadata'] && typeof params.context['metadata'] === 'object')
      ? (params.context['metadata'] as Record<string, unknown>)
      : {};

    const scriptName = String(params.scriptName || metadata['scriptName'] || metadata['fileName'] || '').trim();
    const requestedIds = Array.isArray(metadata['requestedIds']) ? metadata['requestedIds'] : [];
    const removedCount = Number(metadata['removedCount'] || 0);
    const addedCount = Number(metadata['addedCount'] || 0);
    const updatedCount = Number(metadata['updatedCount'] || 0);
    const syncRemovedCount = Number(metadata['removedCount'] || 0);
    const skippedCount = Number(metadata['skippedCount'] || 0);

    if (action === 'SCRIPT_DELETE' || action === 'SCRIPTS_DELETE') {
      if (status === 'NOOP') return 'Script delete requested, but the script was already removed.';
      if (scriptName) return `Script "${scriptName}" deleted from database.`;
      return 'Script deleted from database.';
    }

    if (action === 'SCRIPT_IMPORT') {
      if (scriptName) return `Script "${scriptName}" imported successfully.`;
      return 'Script imported successfully.';
    }

    if (action === 'SCRIPT_IMPORT_DUPLICATE') {
      return 'Duplicate script import blocked.';
    }

    if (action === 'SCRIPT_IMPORT_REJECTED') {
      return 'Script import rejected because the file is not a test script.';
    }

    if (action === 'WORKSPACE_SYNC') {
      const addedScripts = Array.isArray(metadata['addedScripts']) ? metadata['addedScripts'] : [];
      const updatedScripts = Array.isArray(metadata['updatedScripts']) ? metadata['updatedScripts'] : [];
      const removedScripts = Array.isArray(metadata['removedScripts']) ? metadata['removedScripts'] : [];
      const parts: string[] = [];

      if (addedScripts.length > 0) parts.push(`added ${addedScripts.join(', ')}`);
      if (updatedScripts.length > 0) parts.push(`updated ${updatedScripts.join(', ')}`);
      if (removedScripts.length > 0) parts.push(`removed ${removedScripts.join(', ')}`);

      if (parts.length > 0) {
        const suffix = skippedCount > 0 ? ` (skipped ${skippedCount})` : '';
        return `Workspace sync completed: ${parts.join('; ')}${suffix}.`;
      }

      return `Workspace sync: ${addedCount} added, ${updatedCount} updated, ${syncRemovedCount} removed, ${skippedCount} skipped.`;
    }

    if (/^(GET|POST|PUT|PATCH|DELETE)\s+.*->\s+\d{3}\s+\(\d+ms\)$/i.test(rawMessage)) {
      return this.getActionLabel(action);
    }

    return this.sanitizeTechnicalMessage(rawMessage || this.getActionLabel(action));
  }

  private sanitizeTechnicalMessage(message: string): string {
    const text = String(message || '').trim();
    if (!text) return '-';

    if (
      /POM file .*?-f\/--file command-line argument does not exist/i.test(text) ||
      /non-readable pom/i.test(text) ||
      /requires a project to execute but there is no pom/i.test(text)
    ) {
      return 'Execution failed: Maven project configuration (pom.xml) was not found.';
    }

    return text;
  }

  private extractScriptName(action: string, rawMessage: string, context: Record<string, unknown>): string | null {
    const metadata = (context?.['metadata'] && typeof context['metadata'] === 'object')
      ? (context['metadata'] as Record<string, unknown>)
      : {};

    const candidates: Array<unknown> = [
      metadata['scriptName'],
      metadata['updatedName'],
      metadata['fileName'],
    ];

    for (const candidate of candidates) {
      const name = String(candidate || '').trim();
      if (name) {
        return name.replace(/\.java$/i, '');
      }
    }

    const removedNames = Array.isArray(metadata['removedNames']) ? metadata['removedNames'] : [];
    if (removedNames.length === 1) {
      return String(removedNames[0] || '').replace(/\.java$/i, '').trim() || null;
    }

    if (action === 'SCRIPT_DELETE') {
      const quoted = rawMessage.match(/script\s+"([^"]+)"/i);
      if (quoted?.[1]) {
        return quoted[1].replace(/\.java$/i, '').trim();
      }
    }

    return null;
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
