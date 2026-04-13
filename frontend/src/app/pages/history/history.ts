import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { ExecutionService } from '../../services/execution.service';
import { ExecutionRun } from '../../models/interfaces';

type RunStatus = ExecutionRun['status'];
type TimeRange = 'all' | '24h' | '7d' | '30d' | '90d';
type SortBy = 'newest' | 'oldest' | 'duration-desc' | 'duration-asc' | 'failures-desc' | 'pass-rate-desc';
type FilterChipKey = 'search' | 'status' | 'environment' | 'time' | 'sort' | 'failures' | 'artifacts';

interface FilterOption {
  label: string;
  value: string | null;
}

interface StatusInsight {
  status: RunStatus | null;
  label: string;
  icon: string;
  count: number;
}

interface FilterChip {
  key: FilterChipKey;
  label: string;
  value: string;
}

@Component({
  selector: 'app-history',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    FormsModule,
    CardModule,
    TableModule,
    ButtonModule,
    TagModule,
    SelectModule,
    TooltipModule,
    InputTextModule,
    IconFieldModule,
    InputIconModule,
    ToggleSwitchModule,
  ],
  templateUrl: './history.html',
  styleUrl: './history.scss',
})
export class History implements OnInit {
  private readonly dateFormatter = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  readonly allRuns = signal<ExecutionRun[]>([]);
  readonly filteredRuns = signal<ExecutionRun[]>([]);
  readonly loading = signal(true);
  readonly totalRecords = signal(0);
  readonly lastRefreshedAt = signal<string | null>(null);

  readonly totalRunsCount = signal(0);
  readonly overallPassRate = signal(0);
  readonly avgDuration = signal('-');
  readonly lastRunDate = signal('-');
  readonly runningCount = signal(0);
  readonly issueCount = signal(0);

  readonly filteredPassRate = signal(0);
  readonly filteredAvgDuration = signal('-');
  readonly topEnvironmentLabel = signal('-');

  readonly statusInsights = signal<StatusInsight[]>([]);
  readonly activeFilterChips = signal<FilterChip[]>([]);
  readonly environmentOptions = signal<FilterOption[]>([{ label: 'All Environments', value: null }]);

  rows = 10;
  statusFilter: RunStatus | null = null;
  environmentFilter: string | null = null;
  timeRange: TimeRange = 'all';
  sortBy: SortBy = 'newest';
  searchTerm = '';
  failuresOnly = false;
  artifactsOnly = false;

  readonly statusOptions: FilterOption[] = [
    { label: 'All Statuses', value: null },
    { label: 'Running / Queued', value: 'running' },
    { label: 'Passed', value: 'passed' },
    { label: 'Failed', value: 'failed' },
    { label: 'Error', value: 'error' },
    { label: 'Stopped', value: 'stopped' },
  ];

  readonly timeRangeOptions: Array<{ label: string; value: TimeRange }> = [
    { label: 'All Time', value: 'all' },
    { label: 'Last 24 Hours', value: '24h' },
    { label: 'Last 7 Days', value: '7d' },
    { label: 'Last 30 Days', value: '30d' },
    { label: 'Last 90 Days', value: '90d' },
  ];

  readonly sortOptions: Array<{ label: string; value: SortBy }> = [
    { label: 'Newest First', value: 'newest' },
    { label: 'Oldest First', value: 'oldest' },
    { label: 'Longest Duration', value: 'duration-desc' },
    { label: 'Shortest Duration', value: 'duration-asc' },
    { label: 'Most Failures', value: 'failures-desc' },
    { label: 'Highest Pass Rate', value: 'pass-rate-desc' },
  ];

  constructor(private readonly executionService: ExecutionService) {}

  ngOnInit(): void {
    this.statusInsights.set(this.createEmptyStatusInsights());
    this.loadRuns();
  }

  loadRuns(): void {
    this.loading.set(true);

    this.executionService.getRuns({ limit: 1000 }).subscribe({
      next: (data) => {
        const orderedRuns = [...data].sort((a, b) => this.getRunTimestamp(b) - this.getRunTimestamp(a));
        this.allRuns.set(orderedRuns);
        this.refreshBaseInsights(orderedRuns);
        this.buildEnvironmentOptions(orderedRuns);
        this.applyFilters();
        this.lastRefreshedAt.set(new Date().toISOString());
        this.loading.set(false);
      },
      error: () => {
        this.allRuns.set([]);
        this.filteredRuns.set([]);
        this.totalRecords.set(0);
        this.statusInsights.set(this.createEmptyStatusInsights());
        this.activeFilterChips.set([]);
        this.loading.set(false);
      },
    });
  }

  onFilterChange(): void {
    this.applyFilters();
  }

  onPageChange(event: any): void {
    const nextRows = Number(event?.rows ?? this.rows);
    this.rows = Number.isFinite(nextRows) && nextRows > 0 ? nextRows : this.rows;
  }

  applyStatusShortcut(status: RunStatus | null): void {
    this.statusFilter = status;
    this.applyFilters();
  }

  applyIssueShortcut(): void {
    this.statusFilter = null;
    this.failuresOnly = true;
    this.applyFilters();
  }

  clearFilters(): void {
    this.searchTerm = '';
    this.statusFilter = null;
    this.environmentFilter = null;
    this.timeRange = 'all';
    this.sortBy = 'newest';
    this.failuresOnly = false;
    this.artifactsOnly = false;
    this.applyFilters();
  }

  removeFilter(key: FilterChipKey): void {
    switch (key) {
      case 'search':
        this.searchTerm = '';
        break;
      case 'status':
        this.statusFilter = null;
        break;
      case 'environment':
        this.environmentFilter = null;
        break;
      case 'time':
        this.timeRange = 'all';
        break;
      case 'sort':
        this.sortBy = 'newest';
        break;
      case 'failures':
        this.failuresOnly = false;
        break;
      case 'artifacts':
        this.artifactsOnly = false;
        break;
      default:
        break;
    }

    this.applyFilters();
  }

  hasActiveFilters(): boolean {
    return this.activeFilterChips().length > 0;
  }

  isStatusInsightActive(insight: StatusInsight): boolean {
    if (insight.status === null) {
      return this.statusFilter === null && !this.failuresOnly;
    }
    return this.statusFilter === insight.status;
  }

  getStatusSeverity(status: string): 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' {
    switch (status) {
      case 'passed':
        return 'success';
      case 'failed':
      case 'error':
        return 'danger';
      case 'running':
        return 'warn';
      case 'queued':
        return 'info';
      case 'stopped':
        return 'secondary';
      default:
        return 'secondary';
    }
  }

  getFailureCount(run: ExecutionRun): number {
    return this.getFailureCountValue(run);
  }

  getPassPercentage(run: ExecutionRun): number {
    const total = this.getTotalScripts(run);
    if (total <= 0) {
      return 0;
    }
    return Math.round(((run.passedCount || 0) / total) * 100);
  }

  getRunDate(run: ExecutionRun): string | undefined {
    return run.startedAt || run.createdAt || run.completedAt;
  }

  formatDate(date?: string | null): string {
    if (!date) {
      return '-';
    }

    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) {
      return '-';
    }

    return this.dateFormatter.format(parsed);
  }

  formatRelativeDate(date?: string | null): string {
    if (!date) {
      return '-';
    }

    const timestamp = new Date(date).getTime();
    if (!Number.isFinite(timestamp)) {
      return '-';
    }

    const diffMs = Date.now() - timestamp;
    const absDiffMs = Math.abs(diffMs);
    const minuteMs = 60 * 1000;
    const hourMs = 60 * minuteMs;
    const dayMs = 24 * hourMs;

    if (absDiffMs < minuteMs) {
      return 'just now';
    }

    if (absDiffMs < hourMs) {
      const mins = Math.floor(absDiffMs / minuteMs);
      return diffMs >= 0 ? `${mins}m ago` : `in ${mins}m`;
    }

    if (absDiffMs < dayMs) {
      const hours = Math.floor(absDiffMs / hourMs);
      return diffMs >= 0 ? `${hours}h ago` : `in ${hours}h`;
    }

    if (absDiffMs < 30 * dayMs) {
      const days = Math.floor(absDiffMs / dayMs);
      return diffMs >= 0 ? `${days}d ago` : `in ${days}d`;
    }

    return this.formatDate(date);
  }

  formatDuration(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined || Number.isNaN(seconds) || seconds < 0) {
      return '-';
    }

    const rounded = Math.round(seconds);
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor((rounded % 3600) / 60);
    const secs = rounded % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    }

    if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    }

    return `${secs}s`;
  }

  formatEnvironment(environment: string | undefined | null): string {
    const normalized = this.normalizeEnvironment(environment);
    return this.toTitleWords(normalized);
  }

  getExecutionSourceLabel(run: ExecutionRun): string {
    const source = run.runMetadata?.executionSource;
    if (source === 'git') {
      return 'Git';
    }
    if (source === 'local') {
      return 'Local';
    }
    if (run.runType) {
      return this.toTitleWords(run.runType);
    }
    return 'Manual';
  }

  getExecutionSourceIcon(run: ExecutionRun): string {
    const source = run.runMetadata?.executionSource;
    if (source === 'git') {
      return 'pi pi-github';
    }
    if (source === 'local') {
      return 'pi pi-desktop';
    }
    return 'pi pi-play-circle';
  }

  getExecutionSourceClass(run: ExecutionRun): string {
    const source = run.runMetadata?.executionSource;
    if (source === 'git') {
      return 'source-git';
    }
    if (source === 'local') {
      return 'source-local';
    }
    return 'source-manual';
  }

  hasArtifacts(run: ExecutionRun): boolean {
    return this.getArtifactCount(run) > 0;
  }

  getArtifactCount(run: ExecutionRun): number {
    return Number(run.runMetadata?.artifactCount || 0);
  }

  isAttentionRun(run: ExecutionRun): boolean {
    return this.isFailureRun(run);
  }

  isActiveRun(run: ExecutionRun): boolean {
    return run.status === 'running' || run.status === 'queued';
  }

  trackByStatus(_: number, item: StatusInsight): string {
    return item.status || 'all';
  }

  trackByRunId(_: number, run: ExecutionRun): number {
    return run.id;
  }

  exportCSV(): void {
    const csvData = this.filteredRuns();
    if (!csvData || csvData.length === 0) {
      return;
    }

    const headers = [
      'Run ID',
      'Run Name',
      'Status',
      'Environment',
      'Total Scripts',
      'Passed',
      'Failed + Error',
      'Duration (s)',
      'Started At',
      'Triggered By',
      'Execution Source',
      'Artifact Count',
    ];

    const rows = csvData.map((run) =>
      [
        run.id,
        this.escapeCsv(run.runName || 'Manual Run'),
        run.status,
        this.escapeCsv(this.formatEnvironment(run.environment)),
        this.getTotalScripts(run),
        run.passedCount || 0,
        this.getFailureCountValue(run),
        run.durationMs ? (run.durationMs / 1000).toFixed(2) : '0',
        this.escapeCsv(run.startedAt ? new Date(run.startedAt).toISOString() : '-'),
        this.escapeCsv(run.triggeredBy || '-'),
        this.escapeCsv(this.getExecutionSourceLabel(run)),
        this.getArtifactCount(run),
      ].join(',')
    );

    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Execution_History_${this.getExportTimestamp()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  private applyFilters(): void {
    const query = this.searchTerm.trim().toLowerCase();
    const threshold = this.getRangeThreshold(this.timeRange);

    const filtered = this.allRuns()
      .filter((run) => !query || this.buildSearchBlob(run).includes(query))
      .filter((run) => !this.statusFilter || this.matchesStatusFilter(run, this.statusFilter))
      .filter((run) => !this.environmentFilter || this.normalizeEnvironment(run.environment) === this.environmentFilter)
      .filter((run) => !this.failuresOnly || this.isFailureRun(run))
      .filter((run) => !this.artifactsOnly || this.hasArtifacts(run))
      .filter((run) => !threshold || this.getRunTimestamp(run) >= threshold)
      .sort((a, b) => this.compareRuns(a, b, this.sortBy));

    this.filteredRuns.set(filtered);
    this.totalRecords.set(filtered.length);
    this.refreshFilteredInsights(filtered);
    this.updateActiveFilterChips();
  }

  private refreshBaseInsights(runs: ExecutionRun[]): void {
    this.totalRunsCount.set(runs.length);

    const finished = runs.filter((run) => ['passed', 'failed', 'error', 'stopped'].includes(run.status));
    const passedCount = finished.filter((run) => run.status === 'passed').length;
    this.overallPassRate.set(finished.length > 0 ? Math.round((passedCount / finished.length) * 100) : 0);

    const durationSeconds = runs
      .map((run) => (run.durationMs ? run.durationMs / 1000 : 0))
      .filter((value) => value > 0);
    this.avgDuration.set(
      durationSeconds.length > 0
        ? this.formatDuration(durationSeconds.reduce((sum, value) => sum + value, 0) / durationSeconds.length)
        : '-'
    );

    this.lastRunDate.set(runs.length > 0 ? this.formatDate(this.getRunDate(runs[0])) : '-');
    this.runningCount.set(runs.filter((run) => run.status === 'running' || run.status === 'queued').length);
    this.issueCount.set(runs.filter((run) => run.status === 'failed' || run.status === 'error' || run.status === 'stopped').length);
    this.statusInsights.set(this.buildStatusInsights(runs));
  }

  private refreshFilteredInsights(runs: ExecutionRun[]): void {
    const finished = runs.filter((run) => ['passed', 'failed', 'error', 'stopped'].includes(run.status));
    const passedCount = finished.filter((run) => run.status === 'passed').length;
    this.filteredPassRate.set(finished.length > 0 ? Math.round((passedCount / finished.length) * 100) : 0);

    const durationSeconds = runs
      .map((run) => (run.durationMs ? run.durationMs / 1000 : 0))
      .filter((value) => value > 0);
    this.filteredAvgDuration.set(
      durationSeconds.length > 0
        ? this.formatDuration(durationSeconds.reduce((sum, value) => sum + value, 0) / durationSeconds.length)
        : '-'
    );

    if (runs.length === 0) {
      this.topEnvironmentLabel.set('-');
      return;
    }

    const envCounts = new Map<string, number>();
    for (const run of runs) {
      const key = this.normalizeEnvironment(run.environment);
      envCounts.set(key, (envCounts.get(key) || 0) + 1);
    }

    const [topEnvironment] = [...envCounts.entries()].sort((a, b) => b[1] - a[1]);
    this.topEnvironmentLabel.set(topEnvironment ? this.formatEnvironment(topEnvironment[0]) : '-');
  }

  private buildEnvironmentOptions(runs: ExecutionRun[]): void {
    const counts = new Map<string, number>();
    for (const run of runs) {
      const key = this.normalizeEnvironment(run.environment);
      counts.set(key, (counts.get(key) || 0) + 1);
    }

    const options: FilterOption[] = [
      { label: 'All Environments', value: null },
      ...[...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([env, count]) => ({ label: `${this.formatEnvironment(env)} (${count})`, value: env })),
    ];

    this.environmentOptions.set(options);
    if (this.environmentFilter && !options.some((option) => option.value === this.environmentFilter)) {
      this.environmentFilter = null;
    }
  }

  private buildStatusInsights(runs: ExecutionRun[]): StatusInsight[] {
    const activeCount = runs.filter((run) => run.status === 'running' || run.status === 'queued').length;
    const passedCount = runs.filter((run) => run.status === 'passed').length;
    const failedCount = runs.filter((run) => run.status === 'failed').length;
    const errorCount = runs.filter((run) => run.status === 'error').length;
    const stoppedCount = runs.filter((run) => run.status === 'stopped').length;

    return [
      { status: null, label: 'All Runs', icon: 'pi pi-list', count: runs.length },
      { status: 'running', label: 'Active', icon: 'pi pi-spin pi-spinner', count: activeCount },
      { status: 'passed', label: 'Passed', icon: 'pi pi-check-circle', count: passedCount },
      { status: 'failed', label: 'Failed', icon: 'pi pi-times-circle', count: failedCount },
      { status: 'error', label: 'Error', icon: 'pi pi-exclamation-triangle', count: errorCount },
      { status: 'stopped', label: 'Stopped', icon: 'pi pi-stop-circle', count: stoppedCount },
    ];
  }

  private createEmptyStatusInsights(): StatusInsight[] {
    return [
      { status: null, label: 'All Runs', icon: 'pi pi-list', count: 0 },
      { status: 'running', label: 'Active', icon: 'pi pi-spin pi-spinner', count: 0 },
      { status: 'passed', label: 'Passed', icon: 'pi pi-check-circle', count: 0 },
      { status: 'failed', label: 'Failed', icon: 'pi pi-times-circle', count: 0 },
      { status: 'error', label: 'Error', icon: 'pi pi-exclamation-triangle', count: 0 },
      { status: 'stopped', label: 'Stopped', icon: 'pi pi-stop-circle', count: 0 },
    ];
  }

  private updateActiveFilterChips(): void {
    const chips: FilterChip[] = [];

    if (this.searchTerm.trim()) {
      chips.push({ key: 'search', label: 'Search', value: this.searchTerm.trim() });
    }

    if (this.statusFilter) {
      chips.push({ key: 'status', label: 'Status', value: this.getStatusFilterLabel(this.statusFilter) });
    }

    if (this.environmentFilter) {
      chips.push({ key: 'environment', label: 'Environment', value: this.formatEnvironment(this.environmentFilter) });
    }

    if (this.timeRange !== 'all') {
      chips.push({ key: 'time', label: 'Time', value: this.getTimeRangeLabel(this.timeRange) });
    }

    if (this.sortBy !== 'newest') {
      chips.push({ key: 'sort', label: 'Sort', value: this.getSortLabel(this.sortBy) });
    }

    if (this.failuresOnly) {
      chips.push({ key: 'failures', label: 'Mode', value: 'Failures Only' });
    }

    if (this.artifactsOnly) {
      chips.push({ key: 'artifacts', label: 'Mode', value: 'With Artifacts' });
    }

    this.activeFilterChips.set(chips);
  }

  private matchesStatusFilter(run: ExecutionRun, status: RunStatus): boolean {
    if (status === 'running') {
      return run.status === 'running' || run.status === 'queued';
    }
    return run.status === status;
  }

  private isFailureRun(run: ExecutionRun): boolean {
    return run.status === 'failed' || run.status === 'error' || run.status === 'stopped' || this.getFailureCountValue(run) > 0;
  }

  private compareRuns(a: ExecutionRun, b: ExecutionRun, sortBy: SortBy): number {
    switch (sortBy) {
      case 'oldest':
        return this.getRunTimestamp(a) - this.getRunTimestamp(b);
      case 'duration-desc':
        return (b.durationMs || 0) - (a.durationMs || 0);
      case 'duration-asc':
        return (a.durationMs || 0) - (b.durationMs || 0);
      case 'failures-desc':
        return this.getFailureCountValue(b) - this.getFailureCountValue(a) || this.getRunTimestamp(b) - this.getRunTimestamp(a);
      case 'pass-rate-desc':
        return this.getPassPercentage(b) - this.getPassPercentage(a) || this.getRunTimestamp(b) - this.getRunTimestamp(a);
      case 'newest':
      default:
        return this.getRunTimestamp(b) - this.getRunTimestamp(a);
    }
  }

  private getRangeThreshold(range: TimeRange): number | null {
    const now = Date.now();

    switch (range) {
      case '24h':
        return now - 24 * 60 * 60 * 1000;
      case '7d':
        return now - 7 * 24 * 60 * 60 * 1000;
      case '30d':
        return now - 30 * 24 * 60 * 60 * 1000;
      case '90d':
        return now - 90 * 24 * 60 * 60 * 1000;
      case 'all':
      default:
        return null;
    }
  }

  private buildSearchBlob(run: ExecutionRun): string {
    return [
      run.id,
      run.runName || 'manual run',
      run.runType || 'manual',
      run.status,
      run.environment || 'local',
      run.triggeredBy || '',
      run.runMetadata?.executionSource || '',
      run.runMetadata?.gitBranch || '',
      run.runMetadata?.appUrl || '',
    ]
      .join(' ')
      .toLowerCase();
  }

  private getRunTimestamp(run: ExecutionRun): number {
    const candidate = run.startedAt || run.createdAt || run.completedAt;
    if (!candidate) {
      return 0;
    }
    const timestamp = new Date(candidate).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  private getTotalScripts(run: ExecutionRun): number {
    const total = Number(run.totalScripts || 0);
    if (total > 0) {
      return total;
    }

    return (run.passedCount || 0) + (run.failedCount || 0) + (run.errorCount || 0) + (run.skippedCount || 0);
  }

  private getFailureCountValue(run: ExecutionRun): number {
    return Number(run.failedCount || 0) + Number(run.errorCount || 0);
  }

  private getStatusFilterLabel(status: RunStatus): string {
    if (status === 'running') {
      return 'Running / Queued';
    }
    return this.toTitleWords(status);
  }

  private getTimeRangeLabel(range: TimeRange): string {
    return this.timeRangeOptions.find((item) => item.value === range)?.label || 'All Time';
  }

  private getSortLabel(sortBy: SortBy): string {
    return this.sortOptions.find((item) => item.value === sortBy)?.label || 'Newest First';
  }

  private normalizeEnvironment(environment: string | undefined | null): string {
    return String(environment || 'local').trim().toLowerCase() || 'local';
  }

  private toTitleWords(value: string): string {
    return String(value || '')
      .split(/[\s_-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.substring(1).toLowerCase())
      .join(' ');
  }

  private escapeCsv(value: string): string {
    const safe = String(value ?? '');
    if (safe.includes(',') || safe.includes('"') || safe.includes('\n')) {
      return `"${safe.replace(/"/g, '""')}"`;
    }
    return safe;
  }

  private getExportTimestamp(): string {
    const now = new Date();
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  }
}
