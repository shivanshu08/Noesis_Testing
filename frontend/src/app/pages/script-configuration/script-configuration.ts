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
import {
  ScriptConfigurationDetail,
  ScriptConfigurationEditableFile,
  ScriptConfigurationChangeLog,
  ScriptConfigurationFileContent,
  ScriptConfigurationResource,
  ScriptConfigurationRun,
} from '../../models/interfaces';
import { ScriptService } from '../../services/script.service';

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
  readonly editorFullscreen = signal(false);
  readonly attachmentStatusMessage = signal('');
  readonly attachmentActionLoading = signal(false);

  scriptId = 0;

  readonly resourceTotal = computed(() => {
    const detail = this.details();
    if (!detail) return 0;
    return detail.resources.javaConfigs.length + detail.resources.attachments.length;
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
    this.editorFullscreen.set(false);
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
    const totalSeconds = Math.round(durationMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }

  runDuration(run: ScriptConfigurationRun): string {
    return this.formatDuration(run.scriptDurationMs ?? run.runDurationMs ?? null);
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
  }

  closeEditorFullscreen(): void {
    this.editorFullscreen.set(false);
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

  getChangePreview(change: ScriptConfigurationChangeLog): Array<{ line: number; before: string; after: string }> {
    const summary = change.changeSummary as {
      preview?: Array<{ line: number; before: string; after: string }>;
    } | undefined;

    return Array.isArray(summary?.preview) ? summary.preview : [];
  }

  selectChange(change: ScriptConfigurationChangeLog): void {
    this.selectedChangeLogId.set(change.id);
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
}
