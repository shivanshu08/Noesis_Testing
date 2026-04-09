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

  constructor(
    private scriptService: ScriptService,
    private executionService: ExecutionService,
  ) {}

  ngOnInit() {
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

  ngOnDestroy() {
    if (this.currentRunId()) {
      this.executionService.disconnectFromRun();
    }
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
    const scriptIds = this.selectedScripts.map(s => s.id);
    if (scriptIds.length === 0) return;

    this.running.set(true);
    this.logs.set([]);
    this.runStatus.set('running');

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
          }
        }, 500);
      },
      error: (err) => {
        this.logs.update(l => [...l, `✗ Error: ${err.error?.message || 'Failed to start execution'}`]);
        this.running.set(false);
        this.runStatus.set('error');
      },
    });
  }

  stopExecution() {
    const runId = this.currentRunId();
    if (!runId) return;

    this.executionService.stopRun(runId).subscribe({
      next: () => {
        this.logs.update(l => [...l, '', '⏹ Execution stopped by user']);
        this.running.set(false);
        this.runStatus.set('stopped');
        this.executionService.disconnectFromRun();
      },
      error: () => {
        this.logs.update(l => [...l, '✗ Failed to stop execution']);
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
}
