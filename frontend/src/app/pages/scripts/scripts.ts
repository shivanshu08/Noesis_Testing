import { Component, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
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
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TabsModule } from 'primeng/tabs';
import { AvatarModule } from 'primeng/avatar';
import { BadgeModule } from 'primeng/badge';
import { ChipModule } from 'primeng/chip';
import { DividerModule } from 'primeng/divider';
import { MessageService } from 'primeng/api';
import { forkJoin, of, catchError, map } from 'rxjs';
import { ScriptService } from '../../services/script.service';
import { Script, ScriptCategory } from '../../models/interfaces';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../services/auth.service';
import { RouterModule, Router } from '@angular/router';
import { AlertOverlayComponent } from '../../components/alert-overlay/alert-overlay';

@Component({
  selector: 'app-scripts',
  standalone: true,
  imports: [
    CommonModule, FormsModule, TableModule, CardModule, ButtonModule,
    InputTextModule, SelectModule, TagModule, ToggleSwitchModule,
    TooltipModule, IconFieldModule, InputIconModule,
    RouterModule, DialogModule, ProgressBarModule, AlertOverlayComponent,
    ProgressSpinnerModule, TabsModule, AvatarModule, BadgeModule, ChipModule,
    DividerModule
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

  // Assignment Management
  assignmentDialogVisible = signal(false);
  testerUsers = signal<any[]>([]);
  selectedTester = signal<any | null>(null);
  selectedAssignmentIds = signal<Set<number>>(new Set());
  originalAssignmentIds = signal<Set<number>>(new Set());
  assignmentLoading = signal(false);
  assignmentSaving = signal(false);
  assignmentSearch = signal('');
  assignmentCatalogOpen = signal(false);
  assignmentCatalogSearch = signal('');
  assignmentWorkspaceTab = signal<'assigned' | 'catalog' | 'changes'>('assigned');
  assignmentTesterSearch = signal('');
  assignmentSelectedCategory = signal<number | null>(null);
  assignmentCatalogCategory = signal<number | null>(null);
  assignmentCatalogScope = signal<'all' | 'available' | 'blocked'>('all');
  assignmentCatalogScopeOptions = [
    { label: 'All Scripts', value: 'all' },
    { label: 'Available', value: 'available' },
    { label: 'Already Assigned', value: 'blocked' }
  ];

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
    private messageService: MessageService,
    private http: HttpClient
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
    if (!this.auth.canRun()) return;
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

  getAssignedUsers(script: Script): Array<{ id: number; username: string; fullName: string }> {
    return script.assignedUsers || [];
  }

  getPrimaryAssigneeName(script: Script): string {
    const assignee = this.getAssignedUsers(script)[0];
    return assignee?.fullName || assignee?.username || '';
  }

  getRemainingAssigneeCount(script: Script): number {
    return Math.max(0, (script.assignedUserCount || this.getAssignedUsers(script).length || 0) - 1);
  }

  getAssigneeTooltip(script: Script): string {
    const users = this.getAssignedUsers(script);
    if (users.length === 0) return 'No tester assigned';
    return users.map(user => user.fullName || user.username).join(', ');
  }

  timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // --- Assignment Management Methods ---

  assignedScriptsForSelectedTester = computed(() => {
    let scripts = this.scripts();
    const search = this.assignmentSearch().toLowerCase().trim();
    const categoryId = this.assignmentSelectedCategory();

    scripts = scripts.filter(script => this.selectedAssignmentIds().has(script.id));

    if (search) {
      scripts = scripts.filter(s =>
        s.name.toLowerCase().includes(search) ||
        s.className.toLowerCase().includes(search) ||
        (s.categoryName || '').toLowerCase().includes(search)
      );
    }

    if (categoryId) {
      scripts = scripts.filter(s => s.categoryId === categoryId);
    }

    return scripts;
  });

  assignmentCatalogScripts = computed(() => {
    let scripts = this.scripts();
    const search = this.assignmentCatalogSearch().toLowerCase().trim();
    const categoryId = this.assignmentCatalogCategory();
    const scope = this.assignmentCatalogScope();

    if (search) {
      scripts = scripts.filter(s =>
        s.name.toLowerCase().includes(search) ||
        s.className.toLowerCase().includes(search) ||
        (s.categoryName || '').toLowerCase().includes(search) ||
        this.getAssigneeTooltip(s).toLowerCase().includes(search)
      );
    }

    if (categoryId) {
      scripts = scripts.filter(s => s.categoryId === categoryId);
    }

    if (scope === 'available') {
      scripts = scripts.filter(script => !this.isCatalogScriptBlocked(script) && !this.isQueuedAssignment(script));
    } else if (scope === 'blocked') {
      scripts = scripts.filter(script => this.isCatalogScriptBlocked(script));
    }

    return scripts;
  });

  filteredTesterUsers = computed(() => {
    const search = this.assignmentTesterSearch().toLowerCase().trim();
    let testers = this.testerUsers();

    if (search) {
      testers = testers.filter(user =>
        (user.full_name || '').toLowerCase().includes(search) ||
        (user.username || '').toLowerCase().includes(search)
      );
    }

    return testers.slice().sort((a, b) =>
      Number(b.assigned_script_count || 0) - Number(a.assigned_script_count || 0) ||
      String(a.full_name || a.username).localeCompare(String(b.full_name || b.username))
    );
  });

  selectedAssignmentCount = computed(() => this.selectedAssignmentIds().size);
  visibleAssignmentCount = computed(() =>
    this.assignedScriptsForSelectedTester().length
  );
  availableCatalogCount = computed(() =>
    this.assignmentCatalogScripts().filter(script => !this.isCatalogScriptBlocked(script) && !this.isQueuedAssignment(script)).length
  );
  pendingAddCount = computed(() => {
    const current = this.selectedAssignmentIds();
    const original = this.originalAssignmentIds();
    return Array.from(current).filter(id => !original.has(id)).length;
  });
  pendingRemoveCount = computed(() => {
    const current = this.selectedAssignmentIds();
    const original = this.originalAssignmentIds();
    return Array.from(original).filter(id => !current.has(id)).length;
  });
  pendingAddedScripts = computed(() =>
    this.scripts().filter(script => this.selectedAssignmentIds().has(script.id) && !this.originalAssignmentIds().has(script.id))
  );
  pendingRemovedScripts = computed(() =>
    this.scripts().filter(script => this.originalAssignmentIds().has(script.id) && !this.selectedAssignmentIds().has(script.id))
  );
  blockedCatalogCount = computed(() =>
    this.assignmentCatalogScripts().filter(script => this.isCatalogScriptBlocked(script)).length
  );
  assignmentChangeCount = computed(() => {
    const current = this.selectedAssignmentIds();
    const original = this.originalAssignmentIds();
    const allIds = new Set([...Array.from(current), ...Array.from(original)]);
    let changes = 0;
    allIds.forEach(id => {
      if (current.has(id) !== original.has(id)) changes++;
    });
    return changes;
  });

  openAssignmentManagement() {
    this.assignmentDialogVisible.set(true);
    this.assignmentWorkspaceTab.set('assigned');
    this.loadTesterUsers();
  }

  loadTesterUsers() {
    this.assignmentLoading.set(true);
    this.http.get<any[] | { users?: any[]; data?: any[] }>(`${environment.apiUrl}/users`).subscribe({
      next: (response) => {
        const users = this.extractUsers(response);
        const testers = users
          .map(user => this.normalizeUser(user))
          .filter(user => user.role === 'tester' && user.is_active !== false);

        this.testerUsers.set(testers);
        this.assignmentLoading.set(false);
        if (testers.length > 0 && !testers.some(user => user.id === this.selectedTester()?.id)) {
          this.onTesterChange(testers[0]);
        } else if (testers.length === 0) {
          this.selectedTester.set(null);
          this.selectedAssignmentIds.set(new Set());
        }
      },
      error: () => {
        this.messageService.add({ severity: 'error', summary: 'Error', detail: 'Failed to load tester users.' });
        this.assignmentLoading.set(false);
      }
    });
  }

  private extractUsers(response: any[] | { users?: any[]; data?: any[] }): any[] {
    if (Array.isArray(response)) return response;
    if (Array.isArray(response?.users)) return response.users;
    if (Array.isArray(response?.data)) return response.data;
    return [];
  }

  private normalizeUser(user: any): any {
    const fullName = user.fullName || user.full_name || user.name || user.username || 'Unnamed Tester';
    return {
      ...user,
      id: Number(user.id),
      username: user.username || user.email || `user-${user.id}`,
      full_name: fullName,
      fullName,
      role: String(user.role || '').trim().toLowerCase(),
      is_active: user.is_active ?? user.isActive ?? true,
      assigned_script_count: Number(user.assigned_script_count ?? user.assignedScriptCount ?? 0),
    };
  }

  onTesterChange(user: any) {
    this.selectedTester.set(user);
    this.assignmentCatalogOpen.set(false);
    this.assignmentWorkspaceTab.set('assigned');
    this.assignmentSearch.set('');
    this.assignmentCatalogSearch.set('');
    this.assignmentSelectedCategory.set(null);
    this.assignmentCatalogCategory.set(null);
    this.assignmentCatalogScope.set('all');
    this.scriptService.getUserAssignments(user.id).subscribe({
      next: (res) => {
        const assignments = new Set(res.scriptIds);
        this.selectedAssignmentIds.set(assignments);
        this.originalAssignmentIds.set(new Set(assignments));
      },
      error: () => {
        this.selectedAssignmentIds.set(new Set());
        this.originalAssignmentIds.set(new Set());
      }
    });
  }

  toggleAssignment(scriptId: number) {
    const current = new Set(this.selectedAssignmentIds());
    if (current.has(scriptId)) {
      current.delete(scriptId);
    } else {
      current.add(scriptId);
    }
    this.selectedAssignmentIds.set(current);
  }

  isAssignmentSelected(scriptId: number): boolean {
    return this.selectedAssignmentIds().has(scriptId);
  }

  isOriginallyAssigned(scriptId: number): boolean {
    return this.originalAssignmentIds().has(scriptId);
  }

  isQueuedAssignment(script: Script): boolean {
    return this.selectedAssignmentIds().has(script.id) && !this.originalAssignmentIds().has(script.id);
  }

  getAssignedToOtherUsers(script: Script): Array<{ id: number; username: string; fullName: string }> {
    const selectedUserId = Number(this.selectedTester()?.id);
    return this.getAssignedUsers(script).filter(user => Number(user.id) !== selectedUserId);
  }

  isAssignedToAnotherTester(script: Script): boolean {
    return this.getAssignedToOtherUsers(script).length > 0;
  }

  isCatalogScriptBlocked(script: Script): boolean {
    return this.isOriginallyAssigned(script.id) || this.isAssignedToAnotherTester(script);
  }

  getCatalogAssignmentStatus(script: Script): string {
    if (this.isOriginallyAssigned(script.id)) return 'Already assigned to this tester';
    const otherUsers = this.getAssignedToOtherUsers(script);
    if (otherUsers.length > 0) {
      const firstUser = otherUsers[0].fullName || otherUsers[0].username;
      return otherUsers.length > 1 ? `Assigned to ${firstUser} +${otherUsers.length - 1}` : `Assigned to ${firstUser}`;
    }
    if (this.isQueuedAssignment(script)) return 'Queued for assignment';
    return 'Available';
  }

  openAssignmentCatalog() {
    this.assignmentCatalogOpen.set(true);
    this.assignmentWorkspaceTab.set('catalog');
    this.assignmentCatalogSearch.set('');
    this.assignmentCatalogCategory.set(null);
    this.assignmentCatalogScope.set('all');
    this.scriptService.getScripts().subscribe({
      next: (scripts) => {
        this.scripts.set(scripts);
        this.applyFilters();
      },
      error: () => {
        this.messageService.add({ severity: 'warn', summary: 'Refresh Failed', detail: 'Showing the current script list.' });
      }
    });
  }

  closeAssignmentCatalog() {
    this.assignmentCatalogOpen.set(false);
    this.assignmentWorkspaceTab.set('assigned');
    this.assignmentCatalogSearch.set('');
    this.assignmentCatalogCategory.set(null);
    this.assignmentCatalogScope.set('all');
  }

  toggleCatalogAssignment(script: Script) {
    if (this.isCatalogScriptBlocked(script)) return;
    this.toggleAssignment(script.id);
  }

  unassignScript(scriptId: number) {
    const current = new Set(this.selectedAssignmentIds());
    current.delete(scriptId);
    this.selectedAssignmentIds.set(current);
  }

  selectAllAssignments() {
    const current = new Set(this.selectedAssignmentIds());
    this.scripts()
      .filter(script => !this.isCatalogScriptBlocked(script))
      .forEach(script => current.add(script.id));
    this.selectedAssignmentIds.set(current);
  }

  selectVisibleAssignments() {
    const current = new Set(this.selectedAssignmentIds());
    this.assignmentCatalogScripts()
      .filter(script => !this.isCatalogScriptBlocked(script))
      .forEach(script => current.add(script.id));
    this.selectedAssignmentIds.set(current);
  }

  clearVisibleAssignments() {
    const current = new Set(this.selectedAssignmentIds());
    this.assignmentCatalogScripts()
      .filter(script => this.isQueuedAssignment(script))
      .forEach(script => current.delete(script.id));
    this.selectedAssignmentIds.set(current);
  }

  assignCategoryScripts(categoryId: number | null) {
    if (!categoryId) return;
    const current = new Set(this.selectedAssignmentIds());
    this.scripts()
      .filter(script => script.categoryId === categoryId && !this.isCatalogScriptBlocked(script))
      .forEach(script => current.add(script.id));
    this.selectedAssignmentIds.set(current);
  }

  deselectAllAssignments() {
    this.selectedAssignmentIds.set(new Set());
  }

  resetAssignmentChanges() {
    this.selectedAssignmentIds.set(new Set(this.originalAssignmentIds()));
  }

  saveAssignments() {
    const user = this.selectedTester();
    if (!user) return;

    this.assignmentSaving.set(true);
    const scriptIds = Array.from(this.selectedAssignmentIds());

    this.scriptService.updateUserAssignments(user.id, scriptIds).subscribe({
      next: (res) => {
        this.assignmentSaving.set(false);
        this.messageService.add({
          severity: 'success',
          summary: 'Assignments Updated',
          detail: `${res.assignedCount} scripts assigned to ${user.full_name || user.username}.`
        });

        // Update local count in the tester list
        this.testerUsers.update(users =>
          users.map(u => u.id === user.id ? { ...u, assigned_script_count: res.assignedCount } : u)
        );
        this.selectedTester.set({ ...user, assigned_script_count: res.assignedCount });
        this.originalAssignmentIds.set(new Set(this.selectedAssignmentIds()));
        this.assignmentCatalogOpen.set(false);
        this.assignmentWorkspaceTab.set('assigned');
        this.loadScripts();

        // Update current auth user count if it's the logged in user
        if (this.auth.user()?.id === user.id) {
           this.auth.fetchProfile().subscribe();
        }
      },
      error: () => {
        this.assignmentSaving.set(false);
        this.messageService.add({ severity: 'error', summary: 'Error', detail: 'Failed to update assignments.' });
      }
    });
  }

  getAssignmentTag(count: number): 'success' | 'info' | 'warn' | 'danger' {
    if (!count || count === 0) return 'danger';
    if (count < 5) return 'warn';
    return 'success';
  }
}
