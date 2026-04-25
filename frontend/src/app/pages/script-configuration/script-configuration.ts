import { Component, HostListener, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { TableModule } from 'primeng/table';
import { ProgressBarModule } from 'primeng/progressbar';
import { DialogModule } from 'primeng/dialog';
import {
  ScriptConfigurationDetail,
  ScriptConfigurationEditableFile,
  ScriptConfigurationChangeLog,
  ScriptConfigurationChangeLogDetail,
  ScriptConfigurationFileContent,
  ScriptConfigurationResource,
  ScriptConfigurationRun,
} from '../../models/interfaces';
import { formatExecutionEnvironmentLabel } from '../../utils/execution-environment';
import { ScriptService } from '../../services/script.service';

interface CompareLineView {
  lineNumber: number;
  text: string;
  state: 'unchanged' | 'modified' | 'added' | 'removed';
}

@Component({
  selector: 'app-script-configuration',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    CardModule,
    ButtonModule,
    SelectModule,
    TagModule,
    TableModule,
    ProgressBarModule,
    DialogModule,
  ],
  templateUrl: './script-configuration.html',
  styleUrl: './script-configuration.scss',
})
export class ScriptConfiguration implements OnInit, OnDestroy {
  readonly loading = signal(true);
  readonly details = signal<ScriptConfigurationDetail | null>(null);
  readonly loadError = signal('');
  readonly editableFiles = signal<ScriptConfigurationEditableFile[]>([]);
  readonly selectedEditablePath = signal('');
  readonly editorContent = signal('');
  readonly originalEditorContent = signal('');
  readonly editorLoading = signal(false);
  readonly editorSaving = signal(false);
  readonly editorStatusMessage = signal('');
  readonly changeHistory = signal<ScriptConfigurationChangeLog[]>([]);
  readonly changeHistoryLoading = signal(false);
  readonly selectedChangeLogId = signal<number | null>(null);
  readonly compareDialogVisible = signal(false);
  readonly compareDialogLoading = signal(false);
  readonly compareDialogError = signal('');
  readonly compareDetail = signal<ScriptConfigurationChangeLogDetail | null>(null);
  readonly editorFullscreen = signal(false);
  readonly attachmentStatusMessage = signal('');
  readonly attachmentActionLoading = signal(false);
  readonly runStatusFilter = signal<'all' | 'passed' | 'failed' | 'running' | 'queued' | 'skipped'>('all');

  scriptId = 0;
  private bodyOverflowBeforeFullscreen = '';
  private htmlOverflowBeforeFullscreen = '';

  readonly resourceTotal = computed(() => {
    const detail = this.details();
    if (!detail) return 0;
    return detail.resources.javaConfigs.length + this.attachmentResources().length;
  });
  readonly attachmentResources = computed(() => {
    const detail = this.details();
    if (!detail) return [] as ScriptConfigurationResource[];
    return (detail.resources.attachments || []).filter(resource => {
      const sourceValue = String(resource.resolvedPath || resource.reference || '').trim().toLowerCase();
      return !!sourceValue && !sourceValue.endsWith('.json');
    });
  });
  readonly hasUnsavedEditorChanges = computed(() =>
    this.editorContent() !== this.originalEditorContent()
  );
  readonly editableFileOptions = computed(() =>
    this.editableFiles().map(file => ({
      ...file,
      label: this.getFileOptionLabel(file),
    }))
  );
  readonly selectedChangeLog = computed(() => {
    const rows = this.changeHistory();
    if (rows.length === 0) {
      return null;
    }

    const selectedId = this.selectedChangeLogId();
    if (selectedId === null) {
      return rows[0];
    }

    return rows.find(row => row.id === selectedId) || rows[0];
  });
  readonly filteredRuns = computed(() => {
    const detail = this.details();
    if (!detail) {
      return [] as ScriptConfigurationRun[];
    }

    const runs = detail.execution.recentRuns || [];
    const filter = this.runStatusFilter();
    if (filter === 'all') {
      return runs;
    }

    return runs.filter(run => this.matchesRunFilter(run, filter));
  });
  readonly comparePreviousLines = computed(() => this.buildCompareLines('previous'));
  readonly compareCurrentLines = computed(() => this.buildCompareLines('current'));

  constructor(
    private readonly route: ActivatedRoute,
    private readonly scriptService: ScriptService
  ) {}

  ngOnInit(): void {
    this.scriptId = Number(this.route.snapshot.paramMap.get('id'));
    if (!Number.isInteger(this.scriptId) || this.scriptId <= 0) {
      this.loading.set(false);
      return;
    }
    this.loadConfiguration(true);
  }

  ngOnDestroy(): void {
    this.closeEditorFullscreen();
  }

  loadConfiguration(showLoader = false): void {
    if (showLoader) {
      this.loading.set(true);
    }
    this.loadError.set('');

    this.scriptService.getScriptConfiguration(this.scriptId).subscribe({
      next: (data) => {
        this.details.set(data);
        this.configureEditableFiles(data);
        this.loadChangeHistory();
        this.loading.set(false);
      },
      error: (error: HttpErrorResponse) => {
        this.details.set(null);
        this.editableFiles.set([]);
        this.selectedEditablePath.set('');
        this.editorContent.set('');
        this.originalEditorContent.set('');
        this.changeHistory.set([]);
        this.selectedChangeLogId.set(null);
        this.loadError.set(this.buildLoadErrorMessage(error));
        this.loading.set(false);
      },
    });
  }

  private configureEditableFiles(detail: ScriptConfigurationDetail): void {
    const files = this.resolveEditableFiles(detail);
    this.editableFiles.set(files);

    if (files.length === 0) {
      this.selectedEditablePath.set('');
      this.editorContent.set('');
      this.originalEditorContent.set('');
      this.editorStatusMessage.set('No editable Java/JSON configuration files are currently linked to this script.');
      return;
    }

    const currentSelection = this.selectedEditablePath();
    const selectedFile = files.find(file => file.path === currentSelection) || files[0];
    this.selectedEditablePath.set(selectedFile.path);
    this.loadFileContent(selectedFile.path);
  }

  private resolveEditableFiles(detail: ScriptConfigurationDetail): ScriptConfigurationEditableFile[] {
    const fromBackend = detail.editableFiles || [];
    if (fromBackend.length > 0) {
      return fromBackend;
    }

    const resourceCandidates = [
      ...(detail.resources.javaConfigs || []),
      ...(detail.resources.jsonFiles || []),
    ];
    const byPath = new Map<string, ScriptConfigurationEditableFile>();
    for (const resource of resourceCandidates) {
      if (!resource.resolvedPath || !resource.existsOnDisk) continue;
      const normalizedPath = String(resource.resolvedPath);
      if (byPath.has(normalizedPath)) continue;
      const extension = normalizedPath.toLowerCase().endsWith('.json') ? 'json' : normalizedPath.toLowerCase().endsWith('.java') ? 'java' : '';
      if (!extension) continue;
      byPath.set(normalizedPath, {
        path: normalizedPath,
        fileType: extension,
        reference: resource.reference,
        sourceType: resource.type,
        existsOnDisk: resource.existsOnDisk,
      });
    }
    return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
  }

  private buildLoadErrorMessage(error: HttpErrorResponse): string {
    if (error.status === 404) {
      return 'Script configuration endpoint is unavailable or the selected script does not exist.';
    }
    if (error.status === 401 || error.status === 403) {
      return 'You do not have permission to view this script configuration.';
    }
    const serverMessage = typeof error.error?.error === 'string' ? error.error.error : '';
    if (serverMessage) {
      return serverMessage;
    }
    return 'Unable to load script configuration due to a server issue.';
  }

  getStatusSeverity(status: string | null | undefined): 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' {
    const normalized = String(status || '').toLowerCase();
    switch (normalized) {
      case 'passed':
        return 'success';
      case 'failed':
      case 'error':
        return 'danger';
      case 'running':
        return 'warn';
      case 'queued':
        return 'info';
      case 'skipped':
      case 'stopped':
        return 'secondary';
      default:
        return 'secondary';
    }
  }

  formatDate(value: string | Date | null | undefined): string {
    if (!value) return '-';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '-';
    return parsed.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  formatDuration(durationMs: number | null | undefined): string {
    if (!durationMs || Number.isNaN(durationMs) || durationMs < 0) return '-';
    const totalSeconds = durationMs / 1000;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }

  runDuration(run: ScriptConfigurationRun): string {
    return this.formatDuration(run.scriptDurationMs ?? run.runDurationMs ?? null);
  }

  formatRunEnvironment(run: ScriptConfigurationRun): string {
    return formatExecutionEnvironmentLabel(null, run.environment);
  }

  setRunStatusFilter(filter: 'all' | 'passed' | 'failed' | 'running' | 'queued' | 'skipped'): void {
    this.runStatusFilter.set(filter);
  }

  getRunCountForFilter(filter: 'all' | 'passed' | 'failed' | 'running' | 'queued' | 'skipped'): number {
    const detail = this.details();
    if (!detail) return 0;
    const runs = detail.execution.recentRuns || [];
    if (filter === 'all') {
      return runs.length;
    }
    return runs.filter(run => this.matchesRunFilter(run, filter)).length;
  }

  private matchesRunFilter(
    run: ScriptConfigurationRun,
    filter: 'all' | 'passed' | 'failed' | 'running' | 'queued' | 'skipped'
  ): boolean {
    const scriptStatus = String(run.scriptStatus || '').toLowerCase();
    const runStatus = String(run.runStatus || '').toLowerCase();

    if (filter === 'failed') {
      return scriptStatus === 'failed'
        || scriptStatus === 'error'
        || runStatus === 'failed'
        || runStatus === 'error';
    }

    if (filter === 'passed') {
      return scriptStatus === 'passed' || runStatus === 'passed';
    }

    return scriptStatus === filter || runStatus === filter;
  }

  onEditableFileChange(path: string): void {
    if (!path) return;
    this.selectedEditablePath.set(path);
    this.loadFileContent(path);
  }

  loadFileContent(filePath: string): void {
    if (!filePath) return;
    this.editorLoading.set(true);
    this.editorStatusMessage.set('');

    this.scriptService.getScriptConfigurationFileContent(this.scriptId, filePath).subscribe({
      next: (response: ScriptConfigurationFileContent) => {
        this.editorContent.set(response.content || '');
        this.originalEditorContent.set(response.content || '');
        this.editorLoading.set(false);
      },
      error: (error: HttpErrorResponse) => {
        this.editorContent.set('');
        this.originalEditorContent.set('');
        this.editorLoading.set(false);
        this.editorStatusMessage.set(this.buildLoadErrorMessage(error));
      },
    });
  }

  saveSelectedFile(): void {
    const selectedPath = this.selectedEditablePath();
    if (!selectedPath || this.editorSaving()) return;

    this.editorSaving.set(true);
    this.editorStatusMessage.set('');

    this.scriptService.updateScriptConfigurationFile(this.scriptId, {
      path: selectedPath,
      content: this.editorContent(),
    }).subscribe({
      next: (response) => {
        this.editorSaving.set(false);
        this.originalEditorContent.set(this.editorContent());
        const changedLines = Number(response?.changeSummary?.['changedLines'] || 0);
        this.editorStatusMessage.set(changedLines > 0
          ? `Saved successfully. ${changedLines} line(s) updated.`
          : (response?.message || 'Saved successfully.'));
        this.loadConfiguration(false);
      },
      error: (error: HttpErrorResponse) => {
        this.editorSaving.set(false);
        this.editorStatusMessage.set(this.buildLoadErrorMessage(error));
      },
    });
  }

  resetEditorContent(): void {
    this.editorContent.set(this.originalEditorContent());
    this.editorStatusMessage.set('Changes reverted to the last saved version.');
  }

  openEditorFullscreen(): void {
    if (this.editorLoading() || this.editableFiles().length === 0) {
      return;
    }
    this.editorFullscreen.set(true);
    this.lockPageScrollForEditor(true);
  }

  closeEditorFullscreen(): void {
    this.editorFullscreen.set(false);
    this.lockPageScrollForEditor(false);
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.editorFullscreen()) {
      this.closeEditorFullscreen();
    }
  }

  loadChangeHistory(): void {
    this.changeHistoryLoading.set(true);
    this.scriptService.getScriptConfigurationChanges(this.scriptId, 40).subscribe({
      next: (rows) => {
        const nextRows = rows || [];
        this.changeHistory.set(nextRows);
        if (nextRows.length === 0) {
          this.selectedChangeLogId.set(null);
        } else if (!nextRows.some(row => row.id === this.selectedChangeLogId())) {
          this.selectedChangeLogId.set(nextRows[0].id);
        }
        this.changeHistoryLoading.set(false);
      },
      error: () => {
        this.changeHistory.set([]);
        this.selectedChangeLogId.set(null);
        this.changeHistoryLoading.set(false);
      },
    });
  }

  getFileOptionLabel(file: ScriptConfigurationEditableFile): string {
    const normalized = String(file.path || '').replace(/\\/g, '/');
    const fileName = normalized.split('/').pop() || normalized;
    return `${fileName} (${file.fileType.toUpperCase()})`;
  }

  getSelectedEditableFileLabel(): string {
    const selected = this.editableFiles().find(file => file.path === this.selectedEditablePath());
    return selected ? this.getFileOptionLabel(selected) : 'Configuration File';
  }

  getChangedLines(change: ScriptConfigurationChangeLog): number {
    const summary = change.changeSummary as { changedLines?: number } | undefined;
    return Number(summary?.changedLines || 0);
  }

  getChangePreview(change: ScriptConfigurationChangeLog): Array<{
    line: number;
    before: string;
    after: string;
    kind?: string;
    beforeLine?: number | null;
    afterLine?: number | null;
  }> {
    const summary = change.changeSummary as {
      preview?: Array<{
        line: number;
        before: string;
        after: string;
        beforeLine?: number | null;
        afterLine?: number | null;
        kind?: 'modified' | 'added' | 'removed' | string;
      }>;
    } | undefined;

    return Array.isArray(summary?.preview)
      ? summary.preview.map(entry => ({
        line: Number(entry.line || entry.beforeLine || entry.afterLine || 0),
        before: String(entry.before || ''),
        after: String(entry.after || ''),
        kind: String(entry.kind || (entry.before && entry.after ? 'modified' : entry.before ? 'removed' : 'added')),
        beforeLine: entry.beforeLine ?? null,
        afterLine: entry.afterLine ?? null,
      }))
      : [];
  }

  selectChange(change: ScriptConfigurationChangeLog): void {
    this.selectedChangeLogId.set(change.id);
  }

  openCompareDialog(change: ScriptConfigurationChangeLog): void {
    if (!change?.id || this.compareDialogLoading()) {
      return;
    }

    this.compareDialogVisible.set(true);
    this.compareDialogLoading.set(true);
    this.compareDialogError.set('');
    this.compareDetail.set(null);

    this.scriptService.getScriptConfigurationChangeDetail(this.scriptId, change.id).subscribe({
      next: (detail) => {
        this.compareDetail.set(detail);
        this.compareDialogLoading.set(false);
      },
      error: (error: HttpErrorResponse) => {
        this.compareDialogLoading.set(false);
        this.compareDialogError.set(this.buildLoadErrorMessage(error));
      },
    });
  }

  closeCompareDialog(): void {
    this.compareDialogVisible.set(false);
    this.compareDialogLoading.set(false);
    this.compareDialogError.set('');
    this.compareDetail.set(null);
  }

  getModifiedLineCount(change: ScriptConfigurationChangeLog): number {
    const summary = change.changeSummary as { modifiedLines?: number; changedLines?: number } | undefined;
    const modified = Number(summary?.modifiedLines || 0);
    return modified > 0 ? modified : Number(summary?.changedLines || 0);
  }

  getAddedLineCount(change: ScriptConfigurationChangeLog): number {
    const summary = change.changeSummary as { addedLines?: number } | undefined;
    return Number(summary?.addedLines || 0);
  }

  getRemovedLineCount(change: ScriptConfigurationChangeLog): number {
    const summary = change.changeSummary as { removedLines?: number } | undefined;
    return Number(summary?.removedLines || 0);
  }

  getPrimaryChange(change: ScriptConfigurationChangeLog): {
    line: number;
    before: string;
    after: string;
    kind: string;
  } | null {
    const preview = this.getChangePreview(change);
    if (preview.length === 0) {
      return null;
    }
    const first = preview[0] as {
      line: number;
      before: string;
      after: string;
      kind?: string;
    };
    return {
      line: Number(first.line || 0),
      before: String(first.before || ''),
      after: String(first.after || ''),
      kind: String(first.kind || 'modified'),
    };
  }

  getChangeKindLabel(kind: string): string {
    const normalized = String(kind || '').toLowerCase();
    if (normalized === 'added') return 'Added';
    if (normalized === 'removed') return 'Removed';
    return 'Modified';
  }

  trackCompareLine(_: number, line: CompareLineView): string {
    return `${line.lineNumber}:${line.state}:${line.text.length}`;
  }

  private buildCompareLines(side: 'previous' | 'current'): CompareLineView[] {
    const detail = this.compareDetail();
    if (!detail) {
      return [];
    }

    const source = side === 'previous' ? detail.previousContent : detail.updatedContent;
    const rawLines = String(source || '').split(/\r?\n/);
    const lines = rawLines.length > 0 ? rawLines : [''];

    const summary = detail.changeSummary as {
      preview?: Array<{
        kind?: string;
        beforeLine?: number | null;
        afterLine?: number | null;
      }>;
    } | undefined;
    const preview = Array.isArray(summary?.preview) ? summary.preview : [];
    const stateMap = new Map<number, CompareLineView['state']>();

    for (const entry of preview) {
      const kind = String(entry.kind || '').toLowerCase();
      const beforeLine = Number(entry.beforeLine || 0);
      const afterLine = Number(entry.afterLine || 0);

      if (side === 'previous') {
        if (kind === 'modified' && beforeLine > 0) {
          stateMap.set(beforeLine, 'modified');
        } else if (kind === 'removed' && beforeLine > 0) {
          stateMap.set(beforeLine, 'removed');
        }
        continue;
      }

      if (kind === 'modified' && afterLine > 0) {
        stateMap.set(afterLine, 'modified');
      } else if (kind === 'added' && afterLine > 0) {
        stateMap.set(afterLine, 'added');
      }
    }

    return lines.map((lineText, index) => {
      const lineNumber = index + 1;
      return {
        lineNumber,
        text: lineText,
        state: stateMap.get(lineNumber) || 'unchanged',
      };
    });
  }

  formatChangeValue(value: string | null | undefined): string {
    const normalized = String(value || '');
    return normalized.length > 0 ? normalized : '(empty)';
  }

  openAttachment(resource: ScriptConfigurationResource): void {
    this.fetchAttachment(resource, 'open');
  }

  downloadAttachment(resource: ScriptConfigurationResource): void {
    this.fetchAttachment(resource, 'download');
  }

  private fetchAttachment(resource: ScriptConfigurationResource, mode: 'open' | 'download'): void {
    const attachmentPath = String(resource.resolvedPath || '').trim();
    if (!resource.existsOnDisk || !attachmentPath || this.attachmentActionLoading()) {
      return;
    }

    this.attachmentActionLoading.set(true);
    this.attachmentStatusMessage.set('');

    this.scriptService.getScriptConfigurationAttachment(this.scriptId, attachmentPath, mode).subscribe({
      next: (blob) => {
        this.attachmentActionLoading.set(false);
        const fileName = this.getResourceDisplayName(resource);

        if (mode === 'open') {
          const blobUrl = URL.createObjectURL(blob);
          const opened = window.open(blobUrl, '_blank', 'noopener,noreferrer');
          if (!opened) {
            this.downloadBlob(blob, fileName);
          }
          setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
          return;
        }

        this.downloadBlob(blob, fileName);
      },
      error: () => {
        this.attachmentActionLoading.set(false);
        this.attachmentStatusMessage.set('Unable to open/download this attachment right now.');
      },
    });
  }

  private downloadBlob(blob: Blob, fileName: string): void {
    const blobUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = fileName || 'attachment';
    anchor.target = '_blank';
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
  }

  trackEditableFile(_: number, file: ScriptConfigurationEditableFile): string {
    return file.path;
  }

  trackChangeLog(_: number, log: ScriptConfigurationChangeLog): number {
    return log.id;
  }

  copyText(value: string | null | undefined): void {
    const text = String(value || '').trim();
    if (!text || !navigator?.clipboard?.writeText) {
      return;
    }
    navigator.clipboard.writeText(text).catch(() => {});
  }

  trackResource(_: number, resource: ScriptConfigurationResource): string {
    return `${resource.type}|${resource.reference}`;
  }

  trackRun(_: number, run: ScriptConfigurationRun): number {
    return run.runId;
  }

  getResourceDisplayName(resource: ScriptConfigurationResource): string {
    const sourceValue = String(resource.resolvedPath || resource.reference || '').trim();
    if (!sourceValue) return 'Unknown File';
    const normalized = sourceValue.replace(/\\/g, '/');
    const leaf = normalized.split('/').pop() || normalized;
    return leaf || normalized;
  }

  getResourceLogicalName(resource: ScriptConfigurationResource): string {
    const logicalName = typeof resource.metadata?.['logicalName'] === 'string'
      ? String(resource.metadata['logicalName']).trim()
      : '';
    if (logicalName) {
      return logicalName;
    }

    const displayName = this.getResourceDisplayName(resource);
    const lowerName = displayName.toLowerCase();
    if (lowerName.endsWith('.json')) return 'Script Configuration JSON';
    if (lowerName === 'htmlpath.java') return 'HTML Path Locators';
    if (lowerName === 'baseconfig.java') return 'Base Configuration';
    if (lowerName.includes('common') && lowerName.includes('config')) return 'Common Configuration';
    if (lowerName.endsWith('.java')) return 'Java Configuration';
    return 'Configuration File';
  }

  getResourceKindLabel(resource: ScriptConfigurationResource): string {
    const sourceValue = String(resource.resolvedPath || resource.reference || '').trim().toLowerCase();
    if (sourceValue.endsWith('.java')) return 'JAVA';
    if (sourceValue.endsWith('.json')) return 'JSON';
    if (sourceValue.endsWith('.xml')) return 'XML';
    if (sourceValue.endsWith('.pdf')) return 'PDF';
    if (sourceValue.endsWith('.png') || sourceValue.endsWith('.jpg') || sourceValue.endsWith('.jpeg')) return 'IMAGE';
    if (sourceValue.endsWith('.xlsx') || sourceValue.endsWith('.xls')) return 'EXCEL';
    if (sourceValue.endsWith('.txt')) return 'TEXT';
    return 'FILE';
  }

  getResourceDisplayPath(resource: ScriptConfigurationResource): string {
    return String(resource.resolvedPath || resource.reference || '-');
  }

  getBeforeLineCount(change: ScriptConfigurationChangeLog): number {
    const summary = change.changeSummary as { beforeLineCount?: number } | undefined;
    return Number(summary?.beforeLineCount || 0);
  }

  getAfterLineCount(change: ScriptConfigurationChangeLog): number {
    const summary = change.changeSummary as { afterLineCount?: number } | undefined;
    return Number(summary?.afterLineCount || 0);
  }

  private lockPageScrollForEditor(lock: boolean): void {
    if (typeof document === 'undefined') {
      return;
    }

    const body = document.body;
    const html = document.documentElement;
    if (!body || !html) {
      return;
    }

    if (lock) {
      this.bodyOverflowBeforeFullscreen = body.style.overflow;
      this.htmlOverflowBeforeFullscreen = html.style.overflow;
      body.style.overflow = 'hidden';
      html.style.overflow = 'hidden';
      return;
    }

    body.style.overflow = this.bodyOverflowBeforeFullscreen;
    html.style.overflow = this.htmlOverflowBeforeFullscreen;
  }
}
