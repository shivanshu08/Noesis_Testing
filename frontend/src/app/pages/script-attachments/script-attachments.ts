import { Component, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { ScriptConfigurationDetail, ScriptConfigurationResource } from '../../models/interfaces';
import { ScriptService } from '../../services/script.service';

@Component({
  selector: 'app-script-attachments',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    CardModule,
    ButtonModule,
    TagModule,
  ],
  templateUrl: './script-attachments.html',
  styleUrl: './script-attachments.scss',
})
export class ScriptAttachments implements OnInit {
  readonly loading = signal(true);
  readonly loadError = signal('');
  readonly details = signal<ScriptConfigurationDetail | null>(null);
  readonly attachmentActionLoading = signal(false);
  readonly attachmentStatusMessage = signal('');

  scriptId = 0;

  readonly attachments = computed(() => {
    const detail = this.details();
    if (!detail) return [] as ScriptConfigurationResource[];
    return (detail.resources.attachments || [])
      .filter(resource => {
        const sourceValue = String(resource.resolvedPath || resource.reference || '').trim().toLowerCase();
        return !!sourceValue;
      })
      .sort((a, b) => this.getResourceDisplayName(a).localeCompare(this.getResourceDisplayName(b)));
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

  loadConfiguration(showLoader = false): void {
    if (showLoader) {
      this.loading.set(true);
    }
    this.loadError.set('');

    this.scriptService.getScriptConfiguration(this.scriptId).subscribe({
      next: (data) => {
        this.details.set(data);
        this.loading.set(false);
      },
      error: (error: HttpErrorResponse) => {
        this.details.set(null);
        this.loadError.set(this.buildLoadErrorMessage(error));
        this.loading.set(false);
      },
    });
  }

  private buildLoadErrorMessage(error: HttpErrorResponse): string {
    if (error.status === 404) {
      return 'Script configuration endpoint is unavailable or the selected script does not exist.';
    }
    if (error.status === 401 || error.status === 403) {
      return 'You do not have permission to view script attachments.';
    }
    const serverMessage = typeof error.error?.error === 'string' ? error.error.error : '';
    if (serverMessage) {
      return serverMessage;
    }
    return 'Unable to load script attachments due to a server issue.';
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

  trackResource(_: number, resource: ScriptConfigurationResource): string {
    return `${resource.type}|${resource.reference}`;
  }

  getResourceDisplayName(resource: ScriptConfigurationResource): string {
    const sourceValue = String(resource.resolvedPath || resource.reference || '').trim();
    if (!sourceValue) return 'Unknown File';
    const normalized = sourceValue.replace(/\\/g, '/');
    const leaf = normalized.split('/').pop() || normalized;
    return leaf || normalized;
  }

  getResourceDisplayPath(resource: ScriptConfigurationResource): string {
    return String(resource.resolvedPath || resource.reference || '-');
  }

  getResourceKindLabel(resource: ScriptConfigurationResource): string {
    const sourceValue = String(resource.resolvedPath || resource.reference || '').trim().toLowerCase();
    if (sourceValue.endsWith('.json')) return 'JSON';
    if (sourceValue.endsWith('.xml')) return 'XML';
    if (sourceValue.endsWith('.pdf')) return 'PDF';
    if (sourceValue.endsWith('.png') || sourceValue.endsWith('.jpg') || sourceValue.endsWith('.jpeg')) return 'IMAGE';
    if (sourceValue.endsWith('.xlsx') || sourceValue.endsWith('.xls')) return 'EXCEL';
    if (sourceValue.endsWith('.txt') || sourceValue.endsWith('.log')) return 'TEXT';
    if (sourceValue.endsWith('.csv')) return 'CSV';
    return 'FILE';
  }
}
