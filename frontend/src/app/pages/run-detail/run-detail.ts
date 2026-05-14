import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { TableModule } from 'primeng/table';
import { TabsModule } from 'primeng/tabs';
import { TooltipModule } from 'primeng/tooltip';
import { ProgressBarModule } from 'primeng/progressbar';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { DialogModule } from 'primeng/dialog';
import { TextareaModule } from 'primeng/textarea';
import { CheckboxModule } from 'primeng/checkbox';
import { MessageService } from 'primeng/api';
import { ExecutionService } from '../../services/execution.service';
import { ExecutionRun, ExecutionLog, ExecutionArtifact, ExecutionResult } from '../../models/interfaces';
import { AuthService } from '../../services/auth.service';
import { inferEnvironmentFromUrl } from '../../utils/execution-environment';
import { toPercentage } from '../../utils/percentage';
import { environment } from '../../../environments/environment';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

type ResultStatusFilter = 'all' | 'passed' | 'failed' | 'error' | 'running' | 'paused' | 'queued' | 'stopped' | 'skipped';
type ResultSortBy = 'duration-desc' | 'duration-asc' | 'name-asc' | 'name-desc' | 'status';
type LogLevelFilter = 'all' | 'info' | 'warn' | 'error' | 'debug' | 'trace';
interface RunSummaryCounts {
  total: number;
  passed: number;
  failed: number;
  error: number;
  skipped: number;
}

@Component({
  selector: 'app-run-detail',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    FormsModule,
    CardModule,
    ButtonModule,
    TagModule,
    TableModule,
    TabsModule,
    TooltipModule,
    ProgressBarModule,
    SelectModule,
    InputTextModule,
    IconFieldModule,
    InputIconModule,
    DialogModule,
    TextareaModule,
    CheckboxModule,
  ],
  templateUrl: './run-detail.html',
  styleUrl: './run-detail.scss',
})
export class RunDetail implements OnInit, OnDestroy {
  readonly run = signal<ExecutionRun | null>(null);
  readonly logs = signal<ExecutionLog[]>([]);
  readonly artifacts = signal<ExecutionArtifact[]>([]);
  readonly filteredResults = signal<ExecutionResult[]>([]);
  readonly filteredLogs = signal<ExecutionLog[]>([]);
  readonly loading = signal(true);

  runId = 0;
  readonly executionRunUrl = `${environment.apiUrl}/execution/run`;

  resultSearchTerm = '';
  resultStatusFilter: ResultStatusFilter = 'all';
  resultSortBy: ResultSortBy = 'duration-desc';

  logSearchTerm = '';
  logLevelFilter: LogLevelFilter = 'all';

  autoRefreshEnabled = true;

  showMailArtifactsDialog = false;
  mailRecipients = '';
  mailSubject = '';
  mailMessage = '';
  mailArtifactIds: number[] = [];
  mailingArtifacts = false;

  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private liveConnectionActive = false;

  readonly liveLogLines = computed(() => this.executionService.liveLogs().map((log) => this.buildLogLine(log)));
  readonly summaryCounts = computed<RunSummaryCounts>(() => this.buildSummaryCounts(this.run()));

  readonly resultStatusOptions: Array<{ label: string; value: ResultStatusFilter }> = [
    { label: 'All Statuses', value: 'all' },
    { label: 'Passed', value: 'passed' },
    { label: 'Failed', value: 'failed' },
    { label: 'Error', value: 'error' },
    { label: 'Running', value: 'running' },
    { label: 'Paused', value: 'paused' },
    { label: 'Queued', value: 'queued' },
    { label: 'Stopped', value: 'stopped' },
    { label: 'Skipped', value: 'skipped' },
  ];

  readonly resultSortOptions: Array<{ label: string; value: ResultSortBy }> = [
    { label: 'Longest Duration', value: 'duration-desc' },
    { label: 'Shortest Duration', value: 'duration-asc' },
    { label: 'Script Name (A-Z)', value: 'name-asc' },
    { label: 'Script Name (Z-A)', value: 'name-desc' },
    { label: 'Status', value: 'status' },
  ];

  readonly logLevelOptions: Array<{ label: string; value: LogLevelFilter }> = [
    { label: 'All Levels', value: 'all' },
    { label: 'Info', value: 'info' },
    { label: 'Warn', value: 'warn' },
    { label: 'Error', value: 'error' },
    { label: 'Debug', value: 'debug' },
    { label: 'Trace', value: 'trace' },
  ];

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly executionService: ExecutionService,
    private readonly messageService: MessageService,
    public auth: AuthService
  ) {}

  get executionAppUrl(): string {
    const value = this.run()?.runMetadata?.appUrl;
    if (value === null || value === undefined || value === '') return '-';
    return String(value);
  }

  get executionEnvironmentLabel(): string {
    const url = this.executionAppUrl;
    if (url === '-') return this.run()?.environment ? String(this.run()?.environment) : '-';
    if (!/^https?:\/\//i.test(url)) return url;
    return inferEnvironmentFromUrl(url);
  }

  get gitRepositoryDisplay(): string {
    const metadata = this.run()?.runMetadata;
    const name = String(metadata?.gitRepoName || '').trim();
    const url = String(metadata?.gitRepoUrl || '').trim();
    if (name && url) return `${name} (${url})`;
    return name || url || '-';
  }

  get resultTotalCount(): number {
    return this.run()?.results?.length || 0;
  }

  get passedCountValue(): number {
    return this.summaryCounts().passed;
  }

  get failureCount(): number {
    const summary = this.summaryCounts();
    return summary.failed + summary.error;
  }

  get retryableFailedScriptIds(): number[] {
    return Array.from(new Set((this.run()?.results || [])
      .filter((result) => ['failed', 'error'].includes(this.normalizeStatus(result.status)))
      .map((result) => Number(result.scriptId))
      .filter((id) => Number.isInteger(id) && id > 0)));
  }

  get retryableFailedCount(): number {
    return this.retryableFailedScriptIds.length;
  }

  get flakyCount(): number {
    return (this.run()?.results || []).filter((result) => result.isFlaky).length;
  }

  get failureGroups() {
    return this.run()?.failureGroups || [];
  }

  get skippedCountValue(): number {
    return this.summaryCounts().skipped;
  }

  get completedCount(): number {
    const summary = this.summaryCounts();
    return summary.passed + summary.failed + summary.error + summary.skipped;
  }

  get totalScriptsValue(): number {
    return this.summaryCounts().total;
  }

  get passRate(): number {
    const passed = this.passedCountValue;
    const denominator = this.totalScriptsValue;
    return toPercentage(passed, denominator);
  }

  get hasResultFilters(): boolean {
    return !!this.resultSearchTerm.trim() || this.resultStatusFilter !== 'all' || this.resultSortBy !== 'duration-desc';
  }

  get hasLogFilters(): boolean {
    return !!this.logSearchTerm.trim() || this.logLevelFilter !== 'all';
  }

  ngOnInit(): void {
    this.runId = Number(this.route.snapshot.paramMap.get('id'));

    if (!Number.isFinite(this.runId) || this.runId <= 0) {
      this.loading.set(false);
      return;
    }

    this.refreshRunData(true);
  }

  ngOnDestroy(): void {
    this.stopAutoRefresh();
    this.disconnectLiveConnection();
  }

  refreshRunData(showLoader = false): void {
    this.loadRunDetails(showLoader);
    this.loadLogs();
    this.loadArtifacts();
  }

  loadRunDetails(showLoader = true): void {
    if (showLoader) {
      this.loading.set(true);
    }

    this.executionService.getRunDetails(this.runId).subscribe({
      next: (data) => {
        this.run.set(data);
        this.refreshResultView();
        this.handleRealtimeState(data.status);
        if (showLoader) {
          this.loading.set(false);
        }
      },
      error: () => {
        this.handleRealtimeState(null);
        if (showLoader) {
          this.loading.set(false);
        }
      },
    });
  }

  loadLogs(): void {
    this.executionService.getLogs(this.runId).subscribe({
      next: (data) => {
        const orderedLogs = [...data].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        this.logs.set(orderedLogs);
        this.refreshLogView();
        this.applyTerminalLogStatus(orderedLogs);
      },
    });
  }

  loadArtifacts(): void {
    this.executionService.getArtifacts(this.runId).subscribe({
      next: (data) => this.artifacts.set(this.filterArtifacts(data)),
    });
  }

  private filterArtifacts(artifacts: ExecutionArtifact[]): ExecutionArtifact[] {
    const allowedTypes = new Set(['html', 'pdf']);
    return artifacts.filter((artifact) => {
      const type = String(artifact.artifactType || '').toLowerCase();
      return allowedTypes.has(type);
    });
  }

  downloadArtifact(artifact: ExecutionArtifact): void {
    this.executionService.downloadArtifactBlob(artifact.id, artifact.fileName);
  }

  openMailArtifactsDialog(): void {
    const artifacts = this.artifacts();
    if (artifacts.length === 0) {
      this.messageService.add({
        severity: 'warn',
        summary: 'No Artifacts',
        detail: 'There are no captured artifacts available to mail for this run.',
      });
      return;
    }

    this.mailRecipients = '';
    this.mailArtifactIds = artifacts.map((artifact) => artifact.id);
    this.mailSubject = `Noesis artifacts for Run #${this.runId}`;
    this.mailMessage = 'Please find the selected execution artifacts attached.';
    this.mailingArtifacts = false;
    this.showMailArtifactsDialog = true;
  }

  closeMailArtifactsDialog(): void {
    if (this.mailingArtifacts) return;
    this.showMailArtifactsDialog = false;
  }

  isMailArtifactSelected(artifactId: number): boolean {
    return this.mailArtifactIds.includes(artifactId);
  }

  toggleMailArtifact(artifactId: number, checked: boolean): void {
    const next = new Set(this.mailArtifactIds);
    if (checked) {
      next.add(artifactId);
    } else {
      next.delete(artifactId);
    }
    this.mailArtifactIds = Array.from(next);
  }

  toggleAllMailArtifacts(): void {
    const artifacts = this.artifacts();
    this.mailArtifactIds = this.mailArtifactIds.length === artifacts.length
      ? []
      : artifacts.map((artifact) => artifact.id);
  }

  get selectedMailArtifactCount(): number {
    return this.mailArtifactIds.length;
  }

  get mailRecipientList(): string[] {
    return this.mailRecipients
      .split(/[,\n;]/)
      .map((recipient) => recipient.trim())
      .filter(Boolean);
  }

  sendArtifactMail(): void {
    const recipients = this.mailRecipientList;
    const invalidRecipient = recipients.find((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));

    if (recipients.length === 0) {
      this.messageService.add({ severity: 'warn', summary: 'Recipients Required', detail: 'Enter at least one email address.' });
      return;
    }
    if (invalidRecipient) {
      this.messageService.add({ severity: 'error', summary: 'Invalid Email', detail: invalidRecipient });
      return;
    }
    if (this.mailArtifactIds.length === 0) {
      this.messageService.add({ severity: 'warn', summary: 'Artifacts Required', detail: 'Select at least one artifact to attach.' });
      return;
    }

    this.mailingArtifacts = true;
    this.executionService.mailArtifacts(this.runId, {
      recipients,
      artifactIds: this.mailArtifactIds,
      subject: this.mailSubject.trim() || undefined,
      message: this.mailMessage.trim() || undefined,
    }).subscribe({
      next: (response) => {
        this.mailingArtifacts = false;
        this.showMailArtifactsDialog = false;
        this.messageService.add({
          severity: 'success',
          summary: 'Artifacts Mailed',
          detail: response.message || 'Selected artifacts were mailed successfully.',
        });
      },
      error: (error) => {
        this.mailingArtifacts = false;
        this.messageService.add({
          severity: 'error',
          summary: 'Mail Failed',
          detail: error?.error?.error || 'Could not mail artifacts.',
        });
      },
    });
  }

  stopRun(): void {
    if (!this.auth.canEdit()) return;
    this.executionService.stopRun(this.runId).subscribe({
      next: () => this.refreshRunData(true),
    });
  }

  openRerunDialog(): void {
    const current = this.run();
    const scriptIds = Array.from(new Set((current?.results || [])
      .map((result) => Number(result.scriptId))
      .filter((id) => Number.isInteger(id) && id > 0)));
    if (scriptIds.length === 0) {
      this.messageService.add({ severity: 'warn', summary: 'Re-run Unavailable', detail: 'No scripts were found for this run.' });
      return;
    }
    this.router.navigate(['/runner'], {
      queryParams: {
        select: scriptIds.join(','),
        confirm: 1,
        runName: `Re-run: ${current?.runName || `Run #${this.runId}`}`,
      },
    });
  }

  retryFailedScripts(): void {
    const current = this.run();
    let failedScriptIds = this.retryableFailedScriptIds;
    const runStatus = this.normalizeStatus(current?.status);

    if (failedScriptIds.length === 0 && ['failed', 'error'].includes(runStatus)) {
      failedScriptIds = Array.from(new Set((current?.results || [])
        .map((result) => Number(result.scriptId))
        .filter((id) => Number.isInteger(id) && id > 0)));
    }

    if (failedScriptIds.length === 0) {
      this.messageService.add({ severity: 'info', summary: 'Nothing to Retry', detail: 'This run has no failed, errored, or retryable script rows.' });
      return;
    }

    this.router.navigate(['/runner'], {
      queryParams: {
        select: failedScriptIds.join(','),
        confirm: 1,
        runName: `Retry failed: ${current?.runName || `Run #${this.runId}`}`,
      },
    });
  }

  toggleAutoRefresh(): void {
    this.autoRefreshEnabled = !this.autoRefreshEnabled;
    const currentStatus = this.run()?.status;
    this.handleRealtimeState(currentStatus || null);
  }

  applyResultFilters(): void {
    this.refreshResultView();
  }

  clearResultFilters(): void {
    this.resultSearchTerm = '';
    this.resultStatusFilter = 'all';
    this.resultSortBy = 'duration-desc';
    this.refreshResultView();
  }

  applyLogFilters(): void {
    this.refreshLogView();
  }

  clearLogFilters(): void {
    this.logSearchTerm = '';
    this.logLevelFilter = 'all';
    this.refreshLogView();
  }

  getStatusSeverity(status: string): 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' {
    switch (this.normalizeStatus(status)) {
      case 'passed':
        return 'success';
      case 'failed':
      case 'error':
        return 'danger';
      case 'running':
        return 'warn';
      case 'paused':
        return 'info';
      case 'queued':
        return 'info';
      case 'stopped':
      case 'skipped':
        return 'secondary';
      default:
        return 'secondary';
    }
  }

  getRunToneClass(status: string | null | undefined): string {
    switch (this.normalizeStatus(status)) {
      case 'passed':
        return 'status-tone-passed';
      case 'failed':
      case 'error':
        return 'status-tone-failed';
      case 'stopped':
        return 'status-tone-stopped';
      default:
        return 'status-tone-default';
    }
  }

  formatDate(date: string | undefined | null): string {
    if (!date) return '-';

    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) {
      return '-';
    }

    return parsed.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  formatDuration(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined || Number.isNaN(seconds) || seconds < 0) {
      return '-';
    }

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    }

    if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    }

    return `${secs}s`;
  }

  getTimelineWidth(durationMs: number | undefined | null, status: string): number {
    const normStatus = this.normalizeStatus(status);
    if (['skipped', 'queued', 'paused', 'stopped'].includes(normStatus)) {
      return 0;
    }

    const r = this.run();
    if (!r || !r.results || !durationMs) return 0;

    const maxDuration = Math.max(...r.results.map((res) => res.durationMs || 0));
    if (maxDuration === 0) return 50;

    return Math.max(10, Math.round((durationMs / maxDuration) * 100));
  }

  getDurationLabel(result: ExecutionResult): string {
    const status = this.normalizeStatus(result.status);
    if (status === 'skipped') return 'Skipped';
    if (status === 'queued') return 'Queued';
    if (status === 'paused') return 'Paused';
    if (status === 'stopped') return 'Stopped';
    if (status === 'running') return 'In Progress';

    return this.formatDuration(result.durationMs ? result.durationMs / 1000 : null);
  }

  getRemarksLabel(result: ExecutionResult): string {
    if (result.errorMessage) return result.errorMessage;

    const status = this.normalizeStatus(result.status);
    switch (status) {
      case 'passed':
        return 'Execution completed';
      case 'skipped':
        return 'Script was skipped';
      case 'queued':
        return 'Awaiting execution';
      case 'running':
        return 'Actively executing...';
      case 'paused':
        return 'Paused for operator intervention';
      case 'stopped':
        return 'Execution was manually stopped';
      default:
        return '-';
    }
  }

  getFlakyTooltip(result: ExecutionResult): string {
    const total = Number(result.recentRunCount || 0);
    const failed = Number(result.recentFailedCount || 0);
    const rate = Number(result.recentFailureRate || 0);
    return `Flaky signal: ${failed}/${total} recent runs failed (${rate}%).`;
  }

  getRunMetadataValue(field: keyof NonNullable<ExecutionRun['runMetadata']>): string {
    const value = this.run()?.runMetadata?.[field];
    if (value === null || value === undefined || value === '') {
      return '-';
    }
    return String(value);
  }

  copyRunLink(): void {
    this.copyToClipboard(window.location.href);
  }

  copyAppUrl(): void {
    if (this.executionAppUrl !== '-') {
      this.copyToClipboard(this.executionAppUrl);
    }
  }

  copyToClipboard(value: unknown): void {
    const text = String(value ?? '').trim();
    if (!text || text === '-') return;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => this.fallbackCopyToClipboard(text));
      return;
    }

    this.fallbackCopyToClipboard(text);
  }

  downloadLogsTxt(): void {
    const logData = this.filteredLogs();
    if (!logData.length) return;

    const content = logData
      .map((log) => {
        const isoTime = new Date(log.timestamp).toISOString();
        const level = String(log.level || 'info').toUpperCase();
        return `[${isoTime}] [${level}] ${log.message || ''}`;
      })
      .join('\n');

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = `Run_${this.runId}_logs_${this.getExportTimestamp()}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(url);
  }

  trackByResult(_: number, result: ExecutionResult): number {
    return result.id;
  }

  trackByLog(index: number, log: ExecutionLog): string {
    return `${log.timestamp}-${log.level}-${index}`;
  }

  trackByArtifact(_: number, artifact: ExecutionArtifact): number {
    return artifact.id;
  }

  downloadPdf(): void {
    try {
      const r = this.run();
      if (!r) return;

      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.width;

      doc.setFillColor(15, 23, 42);
      doc.rect(0, 0, pageWidth, 28, 'F');

      doc.setFontSize(18);
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.text('Drogevate Testing', 14, 18);

      doc.setFontSize(14);
      doc.setTextColor(40, 40, 40);
      doc.text(`Noesis Run Report #${r.id}`, 14, 40);

      doc.setFontSize(11);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(100, 100, 100);
      doc.text(r.runName || 'Manual Run', 14, 46);

      doc.setDrawColor(226, 232, 240);
      doc.setFillColor(248, 250, 252);
      doc.roundedRect(14, 52, pageWidth - 28, 22, 3, 3, 'FD');

      doc.setFontSize(9);
      doc.setTextColor(71, 85, 105);
      doc.setFont('helvetica', 'bold');

      const statusText = `Status: ${(r.status || 'unknown').toUpperCase()}`;
      doc.text(statusText, 20, 60);
      doc.setFont('helvetica', 'normal');
      doc.text(`Total: ${r.totalScripts || 0} | Passed: ${r.passedCount || 0} | Failed: ${r.failedCount || 0}`, 20, 65);
      doc.text(`Duration: ${this.formatDuration(r.durationMs ? r.durationMs / 1000 : null)}`, 20, 70);

      doc.text(`Started: ${this.formatDate(r.startedAt)}`, 110, 60);
      doc.text(`Pass Rate: ${this.passRate}%`, 110, 65);
      doc.text(`Triggered By: ${r.triggeredBy || '-'}`, 110, 70);

      let startY = 86;

      if (r.results && r.results.length > 0) {
        doc.setFontSize(13);
        doc.setTextColor(15, 23, 42);
        doc.setFont('helvetica', 'bold');
        doc.text('Test Results', 14, startY);
        startY += 6;

        const tableBody = r.results.map((res) => [
          res.scriptName || `Script #${res.scriptId}`,
          (res.status || 'unknown').toUpperCase(),
          this.formatDuration(res.durationMs ? res.durationMs / 1000 : null),
          res.errorMessage || '-',
        ]);

        autoTable(doc, {
          startY,
          head: [['Script', 'Status', 'Duration', 'Error']],
          body: tableBody,
          theme: 'grid',
          headStyles: { fillColor: [71, 85, 105], textColor: 255, fontSize: 9 },
          bodyStyles: { fontSize: 8.5 },
          alternateRowStyles: { fillColor: [248, 250, 252] },
          styles: { cellPadding: 3 },
        });

        startY = (doc as any).lastAutoTable.finalY + 16;
      }

      const logData = this.logs();
      if (logData && logData.length > 0) {
        if (startY > doc.internal.pageSize.height - 30) {
          doc.addPage();
          startY = 20;
        }

        doc.setFontSize(13);
        doc.setTextColor(15, 23, 42);
        doc.setFont('helvetica', 'bold');
        doc.text('Execution Logs', 14, startY);
        startY += 6;

        const logLines = logData.map((l) => {
          const time = new Date(l.timestamp).toLocaleTimeString();
          return `[${time}] [${(l.level || 'info').toUpperCase()}] ${l.message || ''}`;
        });

        autoTable(doc, {
          startY,
          body: logLines.map((line) => [line]),
          theme: 'plain',
          styles: {
            fontSize: 7.5,
            cellPadding: 1.5,
            overflow: 'linebreak',
            font: 'courier',
          },
        });
      }

      const pageCount = doc.internal.pages.length - 1;
      doc.setFontSize(8);
      doc.setTextColor(150);
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.text(`Page ${i} of ${pageCount}`, pageWidth - 30, doc.internal.pageSize.height - 10);
      }

      doc.save(`Noesis_Run_Report_${r.id}.pdf`);
    } catch (e: any) {
      console.error(e);
      this.messageService.add({
        severity: 'error',
        summary: 'PDF Export Failed',
        detail: e?.message ? `Error generating PDF: ${e.message}` : 'Error generating PDF.',
      });
    }
  }

  private refreshResultView(): void {
    const query = this.resultSearchTerm.trim().toLowerCase();
    const statusFilter = this.resultStatusFilter;
    const sortBy = this.resultSortBy;

    const results = [...(this.run()?.results || [])]
      .filter((result) => !query || this.buildResultSearchBlob(result).includes(query))
      .filter((result) => statusFilter === 'all' || this.normalizeStatus(result.status) === statusFilter)
      .sort((a, b) => this.compareResults(a, b, sortBy));

    this.filteredResults.set(results);
  }

  private compareResults(a: ExecutionResult, b: ExecutionResult, sortBy: ResultSortBy): number {
    switch (sortBy) {
      case 'duration-asc':
        return this.safeDurationSeconds(a.durationMs) - this.safeDurationSeconds(b.durationMs);
      case 'duration-desc':
        return this.safeDurationSeconds(b.durationMs) - this.safeDurationSeconds(a.durationMs);
      case 'name-desc':
        return this.getScriptName(b).localeCompare(this.getScriptName(a));
      case 'status': {
        const statusCompare = this.normalizeStatus(a.status).localeCompare(this.normalizeStatus(b.status));
        if (statusCompare !== 0) return statusCompare;
        return this.safeDurationSeconds(b.durationMs) - this.safeDurationSeconds(a.durationMs);
      }
      case 'name-asc':
      default:
        return this.getScriptName(a).localeCompare(this.getScriptName(b));
    }
  }

  private refreshLogView(): void {
    const query = this.logSearchTerm.trim().toLowerCase();
    const levelFilter = this.logLevelFilter;

    const logs = [...this.logs()]
      .filter((log) => !query || this.buildLogLine(log).toLowerCase().includes(query))
      .filter((log) => levelFilter === 'all' || String(log.level || '').toLowerCase() === levelFilter);

    this.filteredLogs.set(logs);
  }

  private buildResultSearchBlob(result: ExecutionResult): string {
    return [
      result.id,
      result.scriptId,
      result.scriptName || '',
      result.className || '',
      result.status || '',
      result.errorMessage || '',
    ]
      .join(' ')
      .toLowerCase();
  }

  private buildLogLine(log: ExecutionLog): string {
    const time = new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false });
    return `[${time}] [${String(log.level || 'info').toUpperCase()}] ${log.message || ''}`;
  }

  private handleRealtimeState(status: string | null): void {
    const isRunning = String(status || '').toLowerCase() === 'running';

    if (isRunning) {
      this.connectLiveConnectionIfNeeded();
      if (this.autoRefreshEnabled) {
        this.startAutoRefresh();
      } else {
        this.stopAutoRefresh();
      }
      return;
    }

    this.stopAutoRefresh();
    this.disconnectLiveConnection();
  }

  private applyTerminalLogStatus(logs: ExecutionLog[]): void {
    const current = this.run();
    if (!current || this.normalizeStatus(current.status) !== 'running') return;

    const terminalStatus = this.inferTerminalStatusFromLogs(logs);
    if (!terminalStatus) return;

    const summary = this.buildSummaryCounts({ ...current, status: terminalStatus });
    this.run.set({
      ...current,
      status: terminalStatus,
      passedCount: terminalStatus === 'passed' && summary.passed === 0 ? summary.total : summary.passed,
      failedCount: terminalStatus === 'failed' && summary.failed + summary.error === 0 ? Math.max(1, summary.total - summary.passed - summary.skipped) : summary.failed,
      errorCount: summary.error,
      skippedCount: summary.skipped,
    });
    this.refreshResultView();
    this.handleRealtimeState(terminalStatus);
    this.loadArtifacts();
    setTimeout(() => this.refreshRunData(false), 1000);
  }

  private inferTerminalStatusFromLogs(logs: ExecutionLog[]): 'passed' | 'failed' | null {
    for (const log of logs) {
      const message = String(log.message || '').toLowerCase();
      if (message.includes('build success')) return 'passed';
      if (message.includes('build failure')) return 'failed';
    }
    return null;
  }

  private connectLiveConnectionIfNeeded(): void {
    if (this.liveConnectionActive) {
      return;
    }

    this.executionService.connectToRun(this.runId);
    this.liveConnectionActive = true;
  }

  private disconnectLiveConnection(): void {
    this.executionService.disconnectFromRun();
    this.liveConnectionActive = false;
  }

  private startAutoRefresh(): void {
    if (this.refreshTimer) {
      return;
    }

    this.refreshTimer = setInterval(() => {
      const current = this.run();
      if (!current || current.status !== 'running') {
        this.stopAutoRefresh();
        return;
      }

      this.loadRunDetails(false);
      this.loadLogs();
      this.loadArtifacts();
    }, 12000);
  }

  private stopAutoRefresh(): void {
    if (!this.refreshTimer) {
      return;
    }

    clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  private safeDurationSeconds(durationMs?: number | null): number {
    if (!durationMs || Number.isNaN(durationMs) || durationMs < 0) return 0;
    return durationMs / 1000;
  }

  private buildSummaryCounts(run: ExecutionRun | null): RunSummaryCounts {
    if (!run) {
      return { total: 0, passed: 0, failed: 0, error: 0, skipped: 0 };
    }

    const rawPassed = Number(run.passedCount || 0);
    let rawFailed = Number(run.failedCount || 0);
    const rawError = Number(run.errorCount || 0);
    const rawSkipped = Number(run.skippedCount || 0);
    const rawTotal = Number(run.totalScripts || 0);

    const results = run.results || [];
    const derivedPassed = this.countResultsByStatuses(results, ['passed']);
    const derivedFailed = this.countResultsByStatuses(results, ['failed']);
    const derivedError = this.countResultsByStatuses(results, ['error']);
    const derivedSkipped = this.countResultsByStatuses(results, ['skipped']);

    const passed = Math.max(rawPassed, derivedPassed);
    rawFailed = Math.max(rawFailed, derivedFailed);
    const error = Math.max(rawError, derivedError);
    const skipped = Math.max(rawSkipped, derivedSkipped);

    const status = this.normalizeStatus(run.status);
    const derivedTotal = results.length;
    const completed = passed + rawFailed + error + skipped;
    const total = Math.max(rawTotal, derivedTotal, completed);

    // Some failed runs report status before aggregate counters are persisted.
    if ((status === 'failed' || status === 'error') && rawFailed + error === 0 && total > 0) {
      rawFailed = Math.max(1, total - passed - skipped);
    }

    return { total, passed, failed: rawFailed, error, skipped };
  }

  private countResultsByStatuses(results: ExecutionResult[], statuses: string[]): number {
    if (!results.length) return 0;
    const statusSet = new Set(statuses.map((status) => this.normalizeStatus(status)));
    return results.reduce((count, result) => count + (statusSet.has(this.normalizeStatus(result.status)) ? 1 : 0), 0);
  }

  private getScriptName(result: ExecutionResult): string {
    return String(result.scriptName || `Script ${result.scriptId || result.id}`);
  }

  private normalizeStatus(value: string | null | undefined): string {
    return String(value || '').trim().toLowerCase();
  }

  private fallbackCopyToClipboard(text: string): void {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    textArea.style.left = '-9999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
    } finally {
      document.body.removeChild(textArea);
    }
  }

  private getExportTimestamp(): string {
    const now = new Date();
    const p = (value: number): string => String(value).padStart(2, '0');
    return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  }
}
