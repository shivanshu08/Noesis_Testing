import { Component, OnDestroy, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { MultiSelectModule } from 'primeng/multiselect';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { SelectModule } from 'primeng/select';
import { ChipModule } from 'primeng/chip';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { InputNumberModule } from 'primeng/inputnumber';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { SuiteService } from '../../services/suite.service';
import { ScriptService } from '../../services/script.service';
import { ExecutionService } from '../../services/execution.service';
import { TestSuite, Script, SuiteAuditLog } from '../../models/interfaces';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { ThemeService } from '../../services/theme.service';
import { Subscription } from 'rxjs';
import { AlertOverlayComponent } from '../../components/alert-overlay/alert-overlay';
import { AlertOverlayService } from '../../services/alert-overlay.service';

@Component({
  selector: 'app-suites',
  standalone: true,
  imports: [
    CommonModule, FormsModule, CardModule, ButtonModule, TableModule,
    DialogModule, InputTextModule, TextareaModule, MultiSelectModule,
    TagModule, TooltipModule, SelectModule,
    ChipModule, ToggleSwitchModule, InputNumberModule, IconFieldModule, InputIconModule,
    AlertOverlayComponent
  ],
  providers: [MessageService],
  templateUrl: './suites.html',
  styleUrl: './suites.scss',
})
export class Suites implements OnInit, OnDestroy {
  suites = signal<TestSuite[]>([]);
  allScripts = signal<Script[]>([]);
  loading = signal(true);
  suiteAuditLoading = signal(false);
  suiteAuditFeed = signal<SuiteAuditLog[]>([]);
  recentSuiteAudit = signal<SuiteAuditLog[]>([]);

  // Search & filter
  searchTerm = '';
  filterMode: string | null = null;
  sortField: string = 'name';
  auditSuiteFilterId: number | null = null;
  auditActionFilter: string | null = null;
  auditDaysFilter = 60;
  auditSearchTerm = '';

  filterModeOptions = [
    { label: 'All', value: null },
    { label: 'Parallel', value: 'parallel' },
    { label: 'Sequential', value: 'sequential' },
  ];

  sortOptions = [
    { label: 'Name', value: 'name' },
    { label: 'Scripts Count', value: 'scripts' },
    { label: 'Date Created', value: 'date' },
    { label: 'Last Run', value: 'lastRun' },
  ];

  auditActionOptions = [
    { label: 'All Actions', value: null },
    { label: 'Created', value: 'SUITES_CREATE' },
    { label: 'Updated', value: 'SUITES_UPDATE' },
    { label: 'Deleted', value: 'SUITES_DELETE' },
  ];

  auditDaysOptions = [
    { label: 'Last 7 days', value: 7 },
    { label: 'Last 30 days', value: 30 },
    { label: 'Last 60 days', value: 60 },
    { label: 'Last 90 days', value: 90 },
    { label: 'Last 180 days', value: 180 },
  ];

  // Computed filtered/sorted
  filteredSuites = computed(() => {
    let result = [...this.suites()];

    // Search filter
    if (this.searchTerm.trim()) {
      const term = this.searchTerm.toLowerCase();
      result = result.filter(s =>
        s.name.toLowerCase().includes(term) ||
        (s.description || '').toLowerCase().includes(term) ||
        (s.tags || []).some(t => t.toLowerCase().includes(term))
      );
    }

    // Mode filter
    if (this.filterMode === 'parallel') {
      result = result.filter(s => s.isParallel);
    } else if (this.filterMode === 'sequential') {
      result = result.filter(s => !s.isParallel);
    }

    // Sort
    result.sort((a, b) => {
      switch (this.sortField) {
        case 'scripts':
          return (b.scriptCount || 0) - (a.scriptCount || 0);
        case 'date':
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        case 'lastRun':
          const aTime = a.lastRunAt ? new Date(a.lastRunAt).getTime() : 0;
          const bTime = b.lastRunAt ? new Date(b.lastRunAt).getTime() : 0;
          return bTime - aTime;
        default:
          return a.name.localeCompare(b.name);
      }
    });

    return result;
  });

  // Stats
  totalSuites = computed(() => this.suites().length);
  totalScriptsInSuites = computed(() => this.suites().reduce((sum, s) => sum + (s.scriptCount || 0), 0));
  parallelCount = computed(() => this.suites().filter(s => s.isParallel).length);
  lastCreated = computed(() => {
    const sorted = [...this.suites()].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return sorted.length > 0 ? this.timeAgo(sorted[0].createdAt) : 'N/A';
  });
  filteredSuiteAuditFeed = computed(() => {
    const search = this.auditSearchTerm.trim().toLowerCase();
    if (!search) return this.suiteAuditFeed();

    return this.suiteAuditFeed().filter((log) => {
      const joinedChangedParts = (log.changedParts || []).join(' ').toLowerCase();
      const combined = [
        log.message,
        log.actor,
        log.suiteName || '',
        log.action || '',
        log.httpPath || '',
        log.requestId || '',
        joinedChangedParts,
      ].join(' ').toLowerCase();
      return combined.includes(search);
    });
  });
  auditFeedCreatedCount = computed(() => this.filteredSuiteAuditFeed().filter((log) => log.action === 'SUITES_CREATE').length);
  auditFeedUpdatedCount = computed(() => this.filteredSuiteAuditFeed().filter((log) => log.action === 'SUITES_UPDATE').length);
  auditFeedDeletedCount = computed(() => this.filteredSuiteAuditFeed().filter((log) => log.action === 'SUITES_DELETE').length);
  auditSuiteOptions = computed(() => ([
    { label: 'All Suites', value: null },
    ...this.suites().map((suite) => ({ label: suite.name, value: suite.id })),
  ]));
  latestAuditBySuite = computed(() => {
    const latestBySuite = new Map<number, SuiteAuditLog>();
    for (const log of this.recentSuiteAudit()) {
      const suiteId = Number(log.suiteId);
      if (!Number.isFinite(suiteId) || suiteId <= 0) continue;
      if (!latestBySuite.has(suiteId)) {
        latestBySuite.set(suiteId, log);
      }
    }
    return latestBySuite;
  });

  // Expand
  expandedSuiteIds = new Set<number>();
  expandedSuiteLoadingIds = new Set<number>();

  // Dialog
  dialogVisible = false;
  editing = false;
  editId: number | null = null;
  suiteAuditVisible = false;
  form = {
    name: '',
    description: '',
    scriptIds: [] as number[],
    isParallel: false,
    threadCount: 1,
    tags: [] as string[],
  };
  newTag = '';

  // Detail dialog
  detailVisible = false;
  detailSuite = signal<TestSuite | null>(null);
  detailLoading = false;

  private scriptRegistrySubscription?: Subscription;

  constructor(
    private suiteService: SuiteService,
    private scriptService: ScriptService,
    private executionService: ExecutionService,
    private alertOverlay: AlertOverlayService,
    private messageService: MessageService,
    private router: Router,
    public auth: AuthService,
    public themeService: ThemeService
  ) { }

  ngOnInit() {
    this.loadSuites();
    this.loadAllScripts();
    this.loadRecentSuiteAudit(true);
    this.scriptRegistrySubscription = this.scriptService.scriptRegistryUpdated$.subscribe(() => {
      this.loadSuites();
      this.loadAllScripts();
      this.loadRecentSuiteAudit(true);
    });
  }

  ngOnDestroy() {
    this.scriptRegistrySubscription?.unsubscribe();
  }

  loadSuites() {
    this.loading.set(true);
    this.suiteService.getSuites().subscribe({
      next: (data) => {
        const availableIds = new Set(data.map((suite) => suite.id));
        this.expandedSuiteIds = new Set(
          Array.from(this.expandedSuiteIds).filter((suiteId) => availableIds.has(suiteId))
        );
        this.expandedSuiteLoadingIds = new Set(
          Array.from(this.expandedSuiteLoadingIds).filter((suiteId) => availableIds.has(suiteId))
        );
        this.suites.set(data);
        this.loading.set(false);
        this.preloadExpandedSuiteScripts();
        this.loadRecentSuiteAudit(true);
      },
      error: () => this.loading.set(false),
    });
  }

  // Expand/collapse row
  toggleExpand(suite: TestSuite) {
    if (this.expandedSuiteIds.has(suite.id)) {
      this.expandedSuiteIds.delete(suite.id);
      this.expandedSuiteLoadingIds.delete(suite.id);
    } else {
      this.expandedSuiteIds.add(suite.id);
      if ((suite.scriptCount || 0) > 0 && (!suite.scripts || suite.scripts.length === 0)) {
        this.loadSuiteScripts(suite.id);
      }
    }
  }

  isExpanded(suite: TestSuite): boolean {
    return this.expandedSuiteIds.has(suite.id);
  }

  isExpandedSuiteScriptsLoading(suite: TestSuite): boolean {
    if ((suite.scriptCount || 0) === 0) return false;
    return this.expandedSuiteLoadingIds.has(suite.id);
  }

  // View detail
  viewDetail(suite: TestSuite) {
    this.detailLoading = true;
    this.detailVisible = true;
    this.suiteService.getSuite(suite.id).subscribe({
      next: (full) => {
        this.detailSuite.set(full);
        this.detailLoading = false;
      },
      error: () => {
        this.detailLoading = false;
        this.messageService.add({ severity: 'error', summary: 'Error', detail: 'Failed to load suite details.' });
      }
    });
  }

  // Create
  openCreate() {
    if (!this.auth.canEdit()) return;
    this.editing = false;
    this.editId = null;
    this.form = { name: '', description: '', scriptIds: [], isParallel: false, threadCount: 1, tags: [] };
    this.newTag = '';
    this.dialogVisible = true;
  }

  // Edit
  openEdit(suite: TestSuite) {
    if (!this.auth.canEdit()) return;
    this.editing = true;
    this.editId = suite.id;
    this.suiteService.getSuite(suite.id).subscribe({
      next: (full) => {
        this.form = {
          name: full.name,
          description: full.description || '',
          scriptIds: full.scripts?.map(s => s.id) || [],
          isParallel: full.isParallel,
          threadCount: full.threadCount || 1,
          tags: full.tags || [],
        };
        this.newTag = '';
        this.dialogVisible = true;
      }
    });
  }

  // Save
  saveSuite() {
    if (!this.form.name.trim()) return;
    if (!this.auth.canEdit()) return;

    const payload = {
      name: this.form.name,
      description: this.form.description,
      scriptIds: this.form.scriptIds,
      isParallel: this.form.isParallel,
      threadCount: this.form.threadCount,
      tags: this.form.tags,
    };

    if (this.editing && this.editId) {
      this.suiteService.updateSuite(this.editId, payload).subscribe({
        next: () => {
          this.dialogVisible = false;
          this.loadSuites();
          this.messageService.add({ severity: 'success', summary: 'Updated', detail: `Suite "${this.form.name}" updated.` });
        },
        error: (err) => {
          const msg = err?.error?.error || err?.error?.message || err?.message || 'Failed to update suite.';
          this.messageService.add({ severity: 'error', summary: 'Error', detail: msg });
        },
      });
    } else {
      this.suiteService.createSuite(payload).subscribe({
        next: () => {
          this.dialogVisible = false;
          this.loadSuites();
          this.messageService.add({ severity: 'success', summary: 'Created', detail: `Suite "${this.form.name}" created.` });
        },
        error: (err) => {
          const msg = err?.error?.error || err?.error?.message || err?.message || 'Failed to create suite.';
          this.messageService.add({ severity: 'error', summary: 'Error', detail: msg });
        },
      });
    }
  }

  // Delete
  async deleteSuite(suite: TestSuite) {
    if (!this.auth.isAdmin()) return;

    const confirmed = await this.alertOverlay.confirm({
      message: this.getDeleteSuiteMessage(suite.name),
      title: 'Delete Suite',
      icon: 'pi pi-trash',
      acceptLabel: 'Delete',
      rejectLabel: 'Cancel',
      acceptIcon: 'pi pi-trash',
      rejectIcon: 'pi pi-times',
      danger: true,
    });

    if (!confirmed) return;

    this.suiteService.deleteSuite(suite.id).subscribe({
      next: () => {
        this.loadSuites();
        this.messageService.add({ severity: 'success', summary: 'Deleted', detail: `Suite "${suite.name}" deleted.` });
      },
    });
  }

  private getDeleteSuiteMessage(suiteName: string): string {
    const normalizedName = suiteName.trim();
    if (!normalizedName) {
      return 'Delete this suite?';
    }

    const compactName = normalizedName.length > 36
      ? `${normalizedName.slice(0, 33)}...`
      : normalizedName;

    return `Delete "${compactName}"?`;
  }

  // Duplicate
  duplicateSuite(suite: TestSuite, event?: Event) {
    event?.stopPropagation();
    if (!this.auth.canEdit()) return;

    this.suiteService.duplicateSuite(suite.id).subscribe({
      next: (res) => {
        this.loadSuites();
        this.messageService.add({ severity: 'success', summary: 'Duplicated', detail: `Created "${res.name}".` });
      },
      error: (err) => {
        const msg = err?.error?.error || err?.message || 'Failed to duplicate suite.';
        this.messageService.add({ severity: 'error', summary: 'Error', detail: msg });
      }
    });
  }

  // Run suite
  runSuite(suite: TestSuite) {
    if (!this.auth.canEdit()) return;

    const scriptIds = suite.scripts?.map(s => s.id) || [];
    if (scriptIds.length === 0) {
      // Need to load scripts first
      this.suiteService.getSuite(suite.id).subscribe({
        next: (full) => {
          const ids = full.scripts?.map(s => s.id) || [];
          if (ids.length === 0) return;
          this.router.navigate(['/runner'], { queryParams: { select: ids.join(','), confirm: 1, runName: suite.name } });
        },
      });
      return;
    }

    this.router.navigate(['/runner'], { queryParams: { select: scriptIds.join(','), confirm: 1, runName: suite.name } });
  }

  // Tags management
  addTag() {
    const tag = this.newTag.trim();
    if (tag && !this.form.tags.includes(tag)) {
      this.form.tags.push(tag);
    }
    this.newTag = '';
  }

  removeTag(index: number) {
    this.form.tags.splice(index, 1);
  }

  onTagKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.addTag();
    }
  }

  // Status helpers
  getStatusSeverity(status: string | undefined): 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' | undefined {
    switch (status) {
      case 'passed': return 'success';
      case 'failed': return 'danger';
      case 'running': return 'info';
      case 'error': return 'warn';
      case 'stopped': return 'secondary';
      default: return 'secondary';
    }
  }

  getStatusLabel(status: string | undefined): string {
    if (!status) return 'Never Run';
    return status.charAt(0).toUpperCase() + status.slice(1);
  }

  // Time formatting
  timeAgo(dateStr: string): string {
    const now = new Date();
    const date = new Date(dateStr);
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 30) return `${days}d ago`;
    return date.toLocaleDateString();
  }

  applyFilters() {
    // Trigger recompute by updating signals (already reactive)
    this.suites.update(s => [...s]);
  }

  clearFilters() {
    this.searchTerm = '';
    this.filterMode = null;
    this.sortField = 'name';
    this.suites.update(s => [...s]);
  }

  getLatestSuiteAudit(suite: TestSuite): SuiteAuditLog | null {
    return this.latestAuditBySuite().get(suite.id) || null;
  }

  getSuiteAuditActionLabel(action: string | undefined): string {
    if (action === 'SUITES_CREATE') return 'Created';
    if (action === 'SUITES_UPDATE') return 'Updated';
    if (action === 'SUITES_DELETE') return 'Deleted';
    return 'Activity';
  }

  getSuiteAuditSeverity(action: string | undefined): 'success' | 'info' | 'danger' | 'secondary' {
    if (action === 'SUITES_CREATE') return 'success';
    if (action === 'SUITES_UPDATE') return 'info';
    if (action === 'SUITES_DELETE') return 'danger';
    return 'secondary';
  }

  getSuiteAuditActor(log: SuiteAuditLog): string {
    const actor = String(log.actor || '').trim();
    if (actor) return actor;
    if (Number.isFinite(Number(log.userId)) && Number(log.userId) > 0) {
      return `User ${Math.trunc(Number(log.userId))}`;
    }
    return 'Unknown user';
  }

  getSuiteAuditTitle(log: SuiteAuditLog): string {
    const suiteName = String(log.suiteName || '').trim();
    if (suiteName) return suiteName;
    if (Number.isFinite(Number(log.suiteId)) && Number(log.suiteId) > 0) {
      return `Suite #${Math.trunc(Number(log.suiteId))}`;
    }
    return 'Suite activity';
  }

  getSuiteAuditSummary(log: SuiteAuditLog): string {
    if (log.changedParts && log.changedParts.length > 0) {
      return `Changed: ${log.changedParts.join(', ')}`;
    }
    if (log.operation) {
      return `Operation: ${log.operation}`;
    }
    if (Number.isFinite(Number(log.httpStatus)) && Number(log.httpStatus) > 0) {
      return `HTTP ${Math.trunc(Number(log.httpStatus))}`;
    }
    return 'No additional details';
  }

  formatSuiteAuditMeta(log: SuiteAuditLog): string {
    const parts: string[] = [];
    if (log.httpMethod) parts.push(log.httpMethod.toUpperCase());
    if (log.httpPath) parts.push(log.httpPath);
    if (log.requestId) parts.push(`#${log.requestId.substring(0, 10)}`);
    return parts.join(' • ');
  }

  private loadAllScripts() {
    this.scriptService.getScripts().subscribe({
      next: (data) => this.allScripts.set(data),
    });
  }

  private loadRecentSuiteAudit(silent = false) {
    this.suiteService.getSuiteAuditLogs({ limit: 160, days: 30 }).subscribe({
      next: (feed) => {
        this.recentSuiteAudit.set(feed || []);
      },
      error: () => {
        if (!silent) {
          this.messageService.add({ severity: 'error', summary: 'Error', detail: 'Failed to load recent suite activity.' });
        }
      }
    });
  }

  private loadSuiteAuditFeed(showToast = true) {
    this.suiteAuditLoading.set(true);
    this.suiteService.getSuiteAuditLogs({
      suiteId: this.auditSuiteFilterId ?? undefined,
      action: this.auditActionFilter || undefined,
      limit: 300,
      days: this.auditDaysFilter,
    }).subscribe({
      next: (feed) => {
        this.suiteAuditFeed.set(feed || []);
        this.suiteAuditLoading.set(false);
        if (showToast) {
          this.messageService.add({
            severity: 'success',
            summary: 'Activity refreshed',
            detail: `${(feed || []).length} suite activity records loaded.`,
          });
        }
      },
      error: () => {
        this.suiteAuditLoading.set(false);
        this.messageService.add({ severity: 'error', summary: 'Error', detail: 'Failed to load suite activity feed.' });
      }
    });
  }

  private preloadExpandedSuiteScripts() {
    const suitesById = new Map(this.suites().map((suite) => [suite.id, suite]));
    for (const suiteId of this.expandedSuiteIds) {
      const suite = suitesById.get(suiteId);
      if (!suite || (suite.scriptCount || 0) === 0) {
        this.expandedSuiteLoadingIds.delete(suiteId);
        continue;
      }

      if (!suite.scripts || suite.scripts.length === 0) {
        this.loadSuiteScripts(suiteId);
      }
    }
  }

  private loadSuiteScripts(suiteId: number) {
    if (this.expandedSuiteLoadingIds.has(suiteId)) return;

    this.expandedSuiteLoadingIds.add(suiteId);
    this.suiteService.getSuite(suiteId).subscribe({
      next: (full) => {
        this.suites.update((suites) =>
          suites.map((suite) => suite.id === suiteId ? { ...suite, scripts: full.scripts || [] } : suite)
        );
        this.expandedSuiteLoadingIds.delete(suiteId);
      },
      error: () => {
        this.expandedSuiteLoadingIds.delete(suiteId);
        this.messageService.add({ severity: 'error', summary: 'Error', detail: 'Failed to load suite scripts.' });
      }
    });
  }

  openSuiteAudit(suite?: TestSuite, event?: Event) {
    event?.stopPropagation();
    this.auditSuiteFilterId = suite?.id ?? null;
    this.auditSearchTerm = '';
    this.suiteAuditVisible = true;
    this.loadSuiteAuditFeed(false);
  }

  refreshSuiteAuditFeed() {
    this.loadSuiteAuditFeed();
    this.loadRecentSuiteAudit(true);
  }

  applySuiteAuditFilters() {
    this.loadSuiteAuditFeed(false);
  }

  clearSuiteAuditFilters() {
    this.auditSuiteFilterId = null;
    this.auditActionFilter = null;
    this.auditDaysFilter = 60;
    this.auditSearchTerm = '';
    this.loadSuiteAuditFeed(false);
  }

  copySuiteAuditLog(log: SuiteAuditLog) {
    const payload = JSON.stringify(log, null, 2);
    navigator.clipboard.writeText(payload).then(() => {
      this.messageService.add({
        severity: 'success',
        summary: 'Copied',
        detail: 'Suite activity JSON copied.',
      });
    }).catch(() => {
      this.messageService.add({
        severity: 'error',
        summary: 'Copy failed',
        detail: 'Unable to copy suite activity JSON.',
      });
    });
  }

  getHealthLabel(status: string | undefined): string {
    if (!status) return '—';
    if (status === 'passed') return '✓ Healthy';
    if (status === 'failed' || status === 'error') return '✗ Unstable';
    return '—';
  }
}
