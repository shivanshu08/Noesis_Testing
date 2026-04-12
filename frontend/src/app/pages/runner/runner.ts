import { Component, OnInit, OnDestroy, signal, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';
import { DividerModule } from 'primeng/divider';
import { PanelModule } from 'primeng/panel';
import { BadgeModule } from 'primeng/badge';
import { TooltipModule } from 'primeng/tooltip';
import { ProgressBarModule } from 'primeng/progressbar';
import { ScriptService } from '../../services/script.service';
import { ExecutionService } from '../../services/execution.service';
import { Script, ScriptCategory } from '../../models/interfaces';
import { AuthService } from '../../services/auth.service';
import { MessageService } from 'primeng/api';
import { Subscription } from 'rxjs';

interface SelectableScript extends Script {
  selected: boolean;
}

@Component({
  selector: 'app-runner',
  standalone: true,
  imports: [
    CommonModule, FormsModule, CardModule, ButtonModule, CheckboxModule,
    SelectModule, InputTextModule, TagModule, DividerModule, PanelModule,
    BadgeModule, TooltipModule, ProgressBarModule,
  ],
  templateUrl: './runner.html',
  styleUrl: './runner.scss',
})
export class Runner implements OnInit, OnDestroy {
  @ViewChild('logContainer') logContainer!: ElementRef;

  scripts = signal<SelectableScript[]>([]);
  categories = signal<ScriptCategory[]>([]);
  logs = signal<string[]>([]);
  loading = signal(true);
  running = signal(false);
  currentRunId = signal<number | null>(null);
  runStatus = signal<string>('');

  selectedCategory: number | null = null;
  searchTerm = '';
  autoScroll = true;
  private scriptRegistrySubscription?: Subscription;

  constructor(
    private scriptService: ScriptService,
    private executionService: ExecutionService,
    private messageService: MessageService,
    public auth: AuthService
  ) {}

  ngOnInit() {
    this.loadRegistryData();
    this.scriptRegistrySubscription = this.scriptService.scriptRegistryUpdated$.subscribe(() => {
      this.loadRegistryData();
    });
  }

  ngOnDestroy() {
    if (this.currentRunId()) {
      this.executionService.disconnectFromRun();
    }
    this.scriptRegistrySubscription?.unsubscribe();
  }

  get filteredScripts(): SelectableScript[] {
    let results = this.scripts();
    if (this.searchTerm) {
      const term = this.searchTerm.toLowerCase();
      results = results.filter(s => s.name.toLowerCase().includes(term) || s.className.toLowerCase().includes(term));
    }
    if (this.selectedCategory) {
      results = results.filter(s => s.categoryId === this.selectedCategory);
    }
    return results;
  }

  get selectedScripts(): SelectableScript[] {
    return this.scripts().filter(s => s.selected);
  }

  get selectedCount(): number {
    return this.selectedScripts.length;
  }

  selectAll() {
    const filtered = this.filteredScripts;
    const allSelected = filtered.every(s => s.selected);
    const updated = this.scripts().map(s => {
      if (filtered.find(f => f.id === s.id)) {
        return { ...s, selected: !allSelected };
      }
      return s;
    });
    this.scripts.set(updated);
  }

  clearSelection() {
    this.scripts.update(list => list.map(s => ({ ...s, selected: false })));
  }

  toggleScript(id: number) {
    this.scripts.update(list => list.map(s =>
      s.id === id ? { ...s, selected: !s.selected } : s
    ));
  }

  selectCategory(catId: number) {
    this.scripts.update(list => list.map(s =>
      s.categoryId === catId ? { ...s, selected: true } : s
    ));
  }

  runSelected() {
    if (!this.auth.canEdit()) return;
    const scriptIds = this.selectedScripts.map(s => s.id);
    if (scriptIds.length === 0) return;

    this.running.set(true);
    this.logs.set([]);
    this.runStatus.set('running');

    // Show toast notification for execution started
    this.messageService.add({ severity: 'info', summary: 'Execution Started', detail: `Running ${scriptIds.length} script(s)...` });

    this.executionService.runScripts(scriptIds).subscribe({
      next: (res) => {
        this.currentRunId.set(res.runId);
        this.logs.update(l => [...l, `▶ Execution started (Run #${res.runId})`]);
        this.logs.update(l => [...l, `  Running ${scriptIds.length} script(s)...`]);
        this.logs.update(l => [...l, '']);

        // Connect to live log stream via signals
        this.executionService.connectToRun(res.runId);

        // Subscribe to live logs from service signal
        const checkInterval = setInterval(() => {
          const serviceLogs = this.executionService.liveLogs();
          if (serviceLogs.length > 0) {
            const newLines = serviceLogs.map(l => l.message);
            this.logs.update(existing => [...existing, ...newLines]);
            this.executionService.liveLogs.set([]);
            if (this.autoScroll) {
              setTimeout(() => this.scrollToBottom(), 50);
            }
          }
          const status = this.executionService.activeRunStatus();
          if (status && status !== 'running') {
            this.running.set(false);
            this.runStatus.set(status);
            clearInterval(checkInterval);

            // Show completion toast notification
            if (status === 'completed') {
              // Parse logs to get passed/failed counts
              const logText = this.logs().join('\n');
              const passedMatch = logText.match(/(\d+)\s+passed/i);
              const failedMatch = logText.match(/(\d+)\s+failed/i);
              const passed = passedMatch ? parseInt(passedMatch[1]) : 0;
              const failed = failedMatch ? parseInt(failedMatch[1]) : scriptIds.length;
              const total = passed + failed;

              this.messageService.add({ severity: 'success', summary: 'Execution Completed', detail: `Total: ${total}, Passed: ${passed}, Failed: ${failed}` });
            } else if (status === 'error') {
              this.messageService.add({ severity: 'error', summary: 'Execution Failed', detail: 'An error occurred during execution' });
            } else if (status === 'stopped') {
              this.messageService.add({ severity: 'warn', summary: 'Execution Stopped', detail: 'The execution was manually stopped' });
            }
          }
        }, 500);
      },
      error: (err) => {
        this.logs.update(l => [...l, `✗ Error: ${err.error?.message || 'Failed to start execution'}`]);
        this.running.set(false);
        this.runStatus.set('error');
        this.messageService.add({ severity: 'error', summary: 'Execution Failed', detail: err.error?.message || 'Failed to start execution' });
      },
    });
  }

  stopExecution() {
    if (!this.auth.canEdit()) return;
    const runId = this.currentRunId();
    if (!runId) return;

    this.executionService.stopRun(runId).subscribe({
      next: () => {
        this.logs.update(l => [...l, '', '⏹ Execution stopped by user']);
        this.running.set(false);
        this.runStatus.set('stopped');
        this.executionService.disconnectFromRun();
        this.messageService.add({ severity: 'warn', summary: 'Execution Stopped', detail: 'The test run was manually stopped' });
      },
      error: () => {
        this.logs.update(l => [...l, '✗ Failed to stop execution']);
        this.messageService.add({ severity: 'error', summary: 'Failed to Stop', detail: 'Could not stop the test run' });
      },
    });
  }

  clearLogs() {
    this.logs.set([]);
    this.running.set(false);
    this.runStatus.set('');
    this.currentRunId.set(null);
  }

  private scrollToBottom() {
    const el = this.logContainer?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }

  getCategoryName(catId: number): string {
    return this.categories().find(c => c.id === catId)?.name || 'Unknown';
  }

  private loadRegistryData() {
    this.loading.set(true);

    this.scriptService.getCategories().subscribe({
      next: (data) => this.categories.set(data),
    });

    this.scriptService.getScripts().subscribe({
      next: (data) => {
        this.scripts.set(data.filter(s => s.isActive).map(s => ({ ...s, selected: false })));
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }
}
