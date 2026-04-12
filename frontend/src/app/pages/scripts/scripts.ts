import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TooltipModule } from 'primeng/tooltip';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { DialogModule } from 'primeng/dialog';
import { ProgressBarModule } from 'primeng/progressbar';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { forkJoin, of, catchError, map } from 'rxjs';
import { ScriptService } from '../../services/script.service';
import { Script, ScriptCategory } from '../../models/interfaces';
import { AuthService } from '../../services/auth.service';
import { RouterModule, Router } from '@angular/router';

@Component({
  selector: 'app-scripts',
  standalone: true,
  imports: [
    CommonModule, FormsModule, TableModule, CardModule, ButtonModule,
    InputTextModule, SelectModule, TagModule, ToggleSwitchModule,
    TooltipModule, IconFieldModule, InputIconModule,
    RouterModule, DialogModule, ProgressBarModule, ToastModule
  ],
  providers: [MessageService],
  templateUrl: './scripts.html',
  styleUrl: './scripts.scss',
})
export class Scripts implements OnInit {
  scripts = signal<Script[]>([]);
  categories = signal<ScriptCategory[]>([]);
  filteredScripts = signal<Script[]>([]);
  selectedScripts = signal<Script[]>([]);
  loading = signal(true);
  syncing = signal(false);

  searchTerm = '';
  selectedCategory: number | null = null;
  selectedAvailability: boolean | null = null;

  statusOptions = [
    { label: 'Ready to Run', value: true, icon: 'pi pi-check-circle' },
    { label: 'Under Maintenance', value: false, icon: 'pi pi-pause-circle' }
  ];
  availabilityFilterOptions = [
    { label: 'Ready to Run', value: true },
    { label: 'Under Maintenance', value: false }
  ];

  syncDialogVisible = signal(false);
  syncProgress = signal(0);
  syncPhase = signal('Initializing...');
  syncStats = signal<any>(null);
  syncDetails = signal<{added: string[], updated: string[], removed: string[], skipped: string[]} | null>(null);

  importDialogVisible = signal(false);
  importProgress = signal(0);
  selectedFileName = signal('');
  alertDialogVisible = signal(false);
  alertDialogTitle = signal('Notice');
  alertDialogMessage = signal('');
  alertDialogSeverity = signal<'success' | 'info' | 'warn' | 'error'>('info');
  deleteDialogVisible = signal(false);
  deletingScripts = signal(false);
  pendingDeleteIds = signal<number[]>([]);
  renameDialogVisible = signal(false);
  renamingScript = signal(false);
  renameScriptId = signal<number | null>(null);
  renameScriptName = signal('');

  constructor(
    private scriptService: ScriptService, 
    public auth: AuthService, 
    private router: Router, 
    private messageService: MessageService
  ) {}

  ngOnInit() {
    this.loadCategories();
    this.loadScripts();
  }

  loadCategories() {
    this.scriptService.getCategories().subscribe({
      next: (data) => this.categories.set(data),
    });
  }

  loadScripts() {
    this.loading.set(true);
    this.scriptService.getScripts().subscribe({
      next: (data) => {
        this.scripts.set(data);
        this.applyFilters();
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  applyFilters() {
    let results = this.scripts();
    if (this.searchTerm) {
      const term = this.searchTerm.toLowerCase();
      results = results.filter(s =>
        s.name.toLowerCase().includes(term) ||
        s.className.toLowerCase().includes(term)
      );
    }
    if (this.selectedCategory) {
      results = results.filter(s => s.categoryId === this.selectedCategory);
    }
    if (this.selectedAvailability !== null) {
      results = results.filter(s => s.isActive === this.selectedAvailability);
    }
    this.filteredScripts.set(results);
  }

  onSearch() {
    this.applyFilters();
  }

  onCategoryChange() {
    this.applyFilters();
  }

  onAvailabilityChange() {
    this.applyFilters();
  }

  toggleScript(script: Script) {
    if (!this.auth.canEdit()) return;

    this.scriptService.updateScript(script.id, { isActive: script.isActive }).subscribe({
      next: () => {
        const updated = this.scripts().map(s =>
          s.id === script.id ? { ...s, isActive: script.isActive } : s
        );
        this.scripts.set(updated);
        this.applyFilters();
        this.messageService.add({ severity: 'success', summary: 'Status Updated', detail: `${script.name} is now ${script.isActive ? 'Ready' : 'Under Maintenance'}.` });
      },
      error: () => {
        this.messageService.add({ severity: 'error', summary: 'Update Failed', detail: 'Could not update script status.' });
      }
    });
  }

  runSelectedScripts() {
    const ids = this.selectedScripts().map(s => s.id).join(',');
    this.router.navigate(['/runner'], { queryParams: { select: ids } });
  }

  promptDeleteSelected() {
    if (!this.auth.canEdit()) return;
    const ids = this.getValidScriptIds(this.selectedScripts().map(s => s.id));
    if (ids.length === 0) return;
    this.pendingDeleteIds.set(ids);
    this.deleteDialogVisible.set(true);
  }

  closeDeleteDialog() {
    this.deleteDialogVisible.set(false);
    this.pendingDeleteIds.set([]);
  }

  confirmDeleteSelected() {
    if (!this.auth.canEdit()) return;
    const ids = this.getValidScriptIds(this.pendingDeleteIds());
    if (ids.length === 0) return;

    this.deletingScripts.set(true);
    this.scriptService.deleteScripts(ids).subscribe({
      next: (res: any) => {
        const removedCount = Number(res?.removedCount || ids.length);
        this.closeDeleteDialog();
        this.deletingScripts.set(false);
        this.selectedScripts.set([]);
        this.loadScripts();
        this.loadCategories();
        this.scriptService.notifyScriptRegistryUpdated();
        this.showAlert(
          removedCount > 1 ? 'Scripts Removed' : 'Script Removed',
          removedCount > 1
            ? `${removedCount} scripts were removed successfully.`
            : 'Selected script was removed successfully.',
          'success'
        );
      },
      error: (err) => {
        if (err?.status === 404) {
          // Backward compatibility for older backends without /delete-multiple.
          this.deleteScriptsLegacy(ids);
          return;
        }

        this.deletingScripts.set(false);
        this.closeDeleteDialog();
        this.showAlert('Delete Failed', this.getSafeDeleteError(err?.status), 'error');
      }
    });
  }

  private deleteScriptsLegacy(ids: number[]) {
    type LegacyDeleteResult = {
      ok: boolean;
      removedCount: number;
      status?: number;
    };

    const deleteRequests = ids.map(id =>
      this.scriptService.deleteScript(id).pipe(
        map((res: any): LegacyDeleteResult => ({
          ok: true,
          removedCount: Number(res?.removedCount ?? 1),
        })),
        catchError((err) => of<LegacyDeleteResult>({
          ok: false,
          removedCount: 0,
          status: err?.status as number | undefined
        }))
      )
    );

    forkJoin(deleteRequests).subscribe({
      next: (results) => {
        const removedCount = results.reduce((total, result) => {
          if (!result.ok) return total;
          return total + Math.max(0, Number(result.removedCount || 0));
        }, 0);

        const hasUnexpectedErrors = results.some(result => !result.ok && result.status !== 404);

        this.deletingScripts.set(false);
        this.closeDeleteDialog();
        this.selectedScripts.set([]);
        this.loadScripts();
        this.loadCategories();
        this.scriptService.notifyScriptRegistryUpdated();

        if (hasUnexpectedErrors) {
          this.showAlert('Delete Failed', 'Some scripts could not be removed. Please try again.', 'error');
          return;
        }

        if (removedCount > 0) {
          this.showAlert(
            removedCount > 1 ? 'Scripts Removed' : 'Script Removed',
            removedCount > 1
              ? `${removedCount} scripts were removed successfully.`
              : 'Selected script was removed successfully.',
            'success'
          );
          return;
        }

        this.showAlert('Already Removed', 'Selected scripts were already removed.', 'info');
      },
      error: () => {
        this.deletingScripts.set(false);
        this.closeDeleteDialog();
        this.showAlert('Delete Failed', 'Could not remove scripts right now. Please try again.', 'error');
      }
    });
  }

  syncScripts() {
    if (!this.auth.isAdmin()) return;

    this.syncDialogVisible.set(true);
    this.syncProgress.set(0);
    this.syncStats.set(null);
    this.syncPhase.set('Scanning repository for test scripts...');

    // Simulate visual scanning progress
    let progress = 0;
    const interval = setInterval(() => {
      progress += Math.floor(Math.random() * 15) + 5;
      if (progress >= 85) {
        clearInterval(interval);
        this.syncPhase.set('Updating database records...');
        this.executeRealSync();
      } else {
        this.syncProgress.set(progress);
        if (progress > 40) this.syncPhase.set('Parsing test annotations and metadata...');
      }
    }, 500);
  }

  private executeRealSync() {
    this.scriptService.syncScripts().subscribe({
      next: (res: any) => {
        this.syncProgress.set(100);
        this.syncPhase.set('Sync Complete!');
        
        const stats = res?.stats || { added: 0, updated: 0, removed: 0, skipped: 0 };
        const details = res?.details || { added: [], updated: [], removed: [], skipped: [] };
        this.syncStats.set(stats);
        this.syncDetails.set(details);
        
        // Automatically refreshes table and DB counts
        this.loadScripts();
        this.loadCategories();
        this.scriptService.notifyScriptRegistryUpdated();

        const skippedCount = Number(stats?.skipped || 0);
        const summary = `Added ${stats?.added || 0}, Updated ${stats?.updated || 0}, Removed ${stats?.removed || 0}${skippedCount > 0 ? `, Skipped ${skippedCount}` : ''}.`;
        this.showAlert(
          skippedCount > 0 ? 'Sync Completed With Warnings' : 'Sync Successful',
          summary,
          skippedCount > 0 ? 'warn' : 'success'
        );
      },
      error: () => {
        this.syncDialogVisible.set(false);
        this.showAlert('Sync Failed', 'Workspace sync is temporarily unavailable. Please try again.', 'error');
      }
    });
  }

  onFileImport(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.java')) {
      this.showAlert('Invalid Format', 'Only .java script files are supported.', 'warn');
      input.value = '';
      return;
    }

    this.selectedFileName.set(file.name);
    this.importDialogVisible.set(true);
    this.importProgress.set(0);

    // Industry-level: Simulate file parsing & uploading progress
    const interval = setInterval(() => this.importProgress.update(p => Math.min(p + 15, 90)), 200);

    this.scriptService.importScript(file).subscribe({
      next: (res: any) => {
        clearInterval(interval);
        this.importProgress.set(100);

        setTimeout(() => {
          this.importDialogVisible.set(false);
          this.showAlert(
            'Import Successful',
            res?.message || `${file.name} was imported successfully.`,
            'success'
          );

          this.loadScripts();
          this.loadCategories();
          this.scriptService.notifyScriptRegistryUpdated();
        }, 600);
      },
      error: (err) => {
        clearInterval(interval);
        this.importDialogVisible.set(false);
        const safeError = this.getSafeImportError(err?.status, file.name);
        this.showAlert(safeError.title, safeError.message, safeError.severity);
      }
    });
    
    input.value = ''; // Reset input
  }

  copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    this.messageService.add({ severity: 'info', summary: 'Copied', detail: 'Class name copied to clipboard.', life: 2000 });
  }

  closeAlertDialog() {
    this.alertDialogVisible.set(false);
  }

  private showAlert(title: string, message: string, severity: 'success' | 'info' | 'warn' | 'error' = 'info') {
    this.alertDialogTitle.set(title);
    this.alertDialogMessage.set(message);
    this.alertDialogSeverity.set(severity);
    this.alertDialogVisible.set(true);
  }

  private getSafeImportError(
    status: number | undefined,
    fileName: string
  ): { title: string; message: string; severity: 'warn' | 'error' } {
    const scriptLabel = (fileName || '').replace(/\.java$/i, '');
    switch (status) {
      case 0:
        return {
          title: 'Connection Issue',
          message: 'Unable to reach the server. Please check your connection and try again.',
          severity: 'error',
        };
      case 400:
        return {
          title: 'Invalid File',
          message: 'Only valid .java script files can be imported.',
          severity: 'warn',
        };
      case 401:
        return {
          title: 'Session Expired',
          message: 'Please login again and retry the import.',
          severity: 'error',
        };
      case 403:
        return {
          title: 'Access Denied',
          message: 'You do not have permission to import scripts.',
          severity: 'error',
        };
      case 404:
        return {
          title: 'Import Unavailable',
          message: 'Script import service is not available right now. Please try again shortly.',
          severity: 'error',
        };
      case 409:
        return {
          title: 'Duplicate Script',
          message: `${scriptLabel || 'This script'} is already imported. Duplicate imports are not allowed.`,
          severity: 'warn',
        };
      case 413:
        return {
          title: 'File Too Large',
          message: 'The selected file is too large to import.',
          severity: 'warn',
        };
      case 422:
        return {
          title: 'Invalid Script',
          message: 'Configuration files cannot be imported as scripts.',
          severity: 'warn',
        };
      default:
        return {
          title: 'Import Failed',
          message: 'Could not import the script right now. Please try again.',
          severity: 'error',
        };
    }
  }

  private getSafeDeleteError(status: number | undefined): string {
    switch (status) {
      case 0:
        return 'Unable to reach the server. Please check your connection and try again.';
      case 401:
        return 'Please login again and retry.';
      case 403:
        return 'You do not have permission to remove scripts.';
      case 404:
        return 'The selected script was not found.';
      default:
        return 'Could not remove scripts right now. Please try again.';
    }
  }

  getDeleteDialogMessage(): string {
    const count = this.pendingDeleteIds().length;
    return count > 1
      ? `Are you sure you want to remove ${count} selected scripts?`
      : 'Are you sure you want to remove the selected script?';
  }

  openRenameDialog(script: Script, event?: Event) {
    event?.stopPropagation();
    if (!this.auth.canEdit()) return;
    this.renameScriptId.set(script.id);
    this.renameScriptName.set((script.name || '').trim());
    this.renameDialogVisible.set(true);
  }

  closeRenameDialog() {
    this.renameDialogVisible.set(false);
    this.renamingScript.set(false);
    this.renameScriptId.set(null);
    this.renameScriptName.set('');
  }

  saveScriptName() {
    if (!this.auth.canEdit()) return;
    const scriptId = this.renameScriptId();
    const nextName = this.renameScriptName().trim();

    if (!scriptId) return;
    if (!nextName) {
      this.showAlert('Invalid Name', 'Script name cannot be empty.', 'warn');
      return;
    }

    this.renamingScript.set(true);
    this.scriptService.updateScript(scriptId, { name: nextName }).subscribe({
      next: () => {
        const updatedScripts = this.scripts().map(script =>
          script.id === scriptId ? { ...script, name: nextName } : script
        );
        const updatedSelected = this.selectedScripts().map(script =>
          script.id === scriptId ? { ...script, name: nextName } : script
        );

        this.scripts.set(updatedScripts);
        this.selectedScripts.set(updatedSelected);
        this.applyFilters();
        this.renamingScript.set(false);
        this.closeRenameDialog();
        this.scriptService.notifyScriptRegistryUpdated();
        this.showAlert('Script Renamed', 'Script name updated successfully.', 'success');
      },
      error: () => {
        this.renamingScript.set(false);
        this.showAlert('Rename Failed', 'Could not update script name right now.', 'error');
      }
    });
  }

  private getValidScriptIds(ids: Array<number | string | null | undefined>): number[] {
    return Array.from(
      new Set(
        ids
          .map(id => Number(id))
          .filter(id => Number.isInteger(id) && id > 0)
      )
    );
  }

  getDisplayScriptName(script: Script): string {
    const sourceName = (script.name || '').trim().replace(/\.java$/i, '');
    if (sourceName) {
      return sourceName;
    }
    return ((script.className || '').split('.').pop() || 'Unnamed Script').replace(/\.java$/i, '');
  }

  getCategoryName(categoryId: number): string {
    return this.categories().find(c => c.id === categoryId)?.name || 'Unknown';
  }

  getCategorySeverity(name: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast' {
    const map: Record<string, 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast'> = {
      Configuration: 'info',
      Feature: 'success',
      Sanity: 'warn',
      Manual: 'secondary',
      API: 'contrast',
      Dashboard: 'info',
      Security: 'danger',
      Intake: 'success',
    };
    return map[name] || 'secondary';
  }
}
