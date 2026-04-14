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
import { ConfirmationService, MessageService } from 'primeng/api';
import { SelectModule } from 'primeng/select';
import { ChipModule } from 'primeng/chip';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { InputNumberModule } from 'primeng/inputnumber';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { SuiteService } from '../../services/suite.service';
import { ScriptService } from '../../services/script.service';
import { ExecutionService } from '../../services/execution.service';
import { TestSuite, Script } from '../../models/interfaces';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { ThemeService } from '../../services/theme.service';
import { Subscription } from 'rxjs';
import { AlertOverlayComponent } from '../../components/alert-overlay/alert-overlay';

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
  providers: [ConfirmationService, MessageService],
  templateUrl: './suites.html',
  styleUrl: './suites.scss',
})
export class Suites implements OnInit, OnDestroy {
  suites = signal<TestSuite[]>([]);
  allScripts = signal<Script[]>([]);
  loading = signal(true);

  // Search & filter
  searchTerm = '';
  filterMode: string | null = null;
  sortField: string = 'name';

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

  // Expand
  expandedSuiteIds = new Set<number>();

  // Dialog
  dialogVisible = false;
  editing = false;
  editId: number | null = null;
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
    private confirmService: ConfirmationService,
    private messageService: MessageService,
    private router: Router,
    public auth: AuthService,
    public themeService: ThemeService
  ) {}

  ngOnInit() {
    this.loadSuites();
    this.loadAllScripts();
    this.scriptRegistrySubscription = this.scriptService.scriptRegistryUpdated$.subscribe(() => {
      this.loadSuites();
      this.loadAllScripts();
    });
  }

  ngOnDestroy() {
    this.scriptRegistrySubscription?.unsubscribe();
  }

  loadSuites() {
    this.loading.set(true);
    this.suiteService.getSuites().subscribe({
      next: (data) => {
        this.suites.set(data);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  // Expand/collapse row
  toggleExpand(suite: TestSuite) {
    if (this.expandedSuiteIds.has(suite.id)) {
      this.expandedSuiteIds.delete(suite.id);
    } else {
      this.expandedSuiteIds.add(suite.id);
      // Load full suite details if scripts not loaded
      if (!suite.scripts || suite.scripts.length === 0) {
        this.suiteService.getSuite(suite.id).subscribe({
          next: (full) => {
            this.suites.update(suites =>
              suites.map(s => s.id === suite.id ? { ...s, scripts: full.scripts } : s)
            );
          }
        });
      }
    }
  }

  isExpanded(suite: TestSuite): boolean {
    return this.expandedSuiteIds.has(suite.id);
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
        error: () => this.messageService.add({ severity: 'error', summary: 'Error', detail: 'Failed to update suite.' }),
      });
    } else {
      this.suiteService.createSuite(payload).subscribe({
        next: () => {
          this.dialogVisible = false;
          this.loadSuites();
          this.messageService.add({ severity: 'success', summary: 'Created', detail: `Suite "${this.form.name}" created.` });
        },
        error: () => this.messageService.add({ severity: 'error', summary: 'Error', detail: 'Failed to create suite.' }),
      });
    }
  }

  // Delete
  deleteSuite(suite: TestSuite) {
    if (!this.auth.isAdmin()) return;

    this.confirmService.confirm({
      message: this.getDeleteSuiteMessage(suite.name),
      header: 'Delete Suite',
      icon: 'pi pi-trash',
      acceptLabel: 'Delete',
      rejectLabel: 'Cancel',
      acceptIcon: 'pi pi-trash',
      rejectIcon: 'pi pi-times',
      defaultFocus: 'reject',
      acceptButtonStyleClass: 'p-button-sm p-button-danger',
      rejectButtonStyleClass: 'p-button-sm p-button-text p-button-secondary',
      accept: () => {
        this.suiteService.deleteSuite(suite.id).subscribe({
          next: () => {
            this.loadSuites();
            this.messageService.add({ severity: 'success', summary: 'Deleted', detail: `Suite "${suite.name}" deleted.` });
          },
        });
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
  duplicateSuite(suite: TestSuite) {
    if (!this.auth.canEdit()) return;

    this.suiteService.duplicateSuite(suite.id).subscribe({
      next: (res) => {
        this.loadSuites();
        this.messageService.add({ severity: 'success', summary: 'Duplicated', detail: `Created "${res.name}".` });
      },
      error: () => this.messageService.add({ severity: 'error', summary: 'Error', detail: 'Failed to duplicate suite.' }),
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
          this.executionService.runScripts(ids, suite.name).subscribe({
            next: (res) => this.router.navigate(['/run', res.runId]),
          });
        },
      });
      return;
    }

    this.executionService.runScripts(scriptIds, suite.name).subscribe({
      next: (res) => this.router.navigate(['/run', res.runId]),
    });
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

  private loadAllScripts() {
    this.scriptService.getScripts().subscribe({
      next: (data) => this.allScripts.set(data),
    });
  }

  getHealthLabel(status: string | undefined): string {
    if (!status) return '—';
    if (status === 'passed') return '✓ Healthy';
    if (status === 'failed' || status === 'error') return '✗ Unstable';
    return '—';
  }
}
