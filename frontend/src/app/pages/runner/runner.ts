import { Component, OnInit, OnDestroy, signal, ViewChild, ElementRef, HostListener } from '@angular/core';
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
import { DialogModule } from 'primeng/dialog';
import { TextareaModule } from 'primeng/textarea';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { DatePickerModule } from 'primeng/datepicker';
import { ScriptService } from '../../services/script.service';
import { ExecutionService } from '../../services/execution.service';
import { Script, ScriptCategory, ScheduledRun } from '../../models/interfaces';
import { AuthService } from '../../services/auth.service';
import { MessageService } from 'primeng/api';
import { Subscription } from 'rxjs';

interface SelectableScript extends Script {
  selected: boolean;
}

interface CronPreset {
  label: string;
  icon: string;
  cron: string;
  description: string;
}

@Component({
  selector: 'app-runner',
  standalone: true,
  imports: [
    CommonModule, FormsModule, CardModule, ButtonModule, CheckboxModule,
    SelectModule, InputTextModule, TagModule, DividerModule, PanelModule,
    BadgeModule, TooltipModule, ProgressBarModule, DialogModule,
    TextareaModule, ToggleSwitchModule, DatePickerModule
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
  schedules = signal<ScheduledRun[]>([]);

  selectedCategory: number | null = null;
  searchTerm = '';
  autoScroll = true;
  private scriptRegistrySubscription?: Subscription;

  // Run Confirmation Dialog
  showRunConfirm = false;
  runName = '';

  // Schedule Dialog
  showScheduleDialog = false;
  scheduleName = '';
  scheduleCron = '';
  scheduleType: 'recurring' | 'once' = 'recurring';
  scheduleDate: Date | null = null;
  minScheduleDate: Date = new Date();
  scheduleDescription = '';
  scheduleEnvironment = 'local';
  savingSchedule = false;

  // Timer
  elapsedSeconds = 0;
  private timerInterval: any = null;

  // Scheduled Runs Panel
  showSchedulesPanel = false;
  loadingSchedules = false;

  // Cron presets — daily & weekly
  cronPresets: CronPreset[] = [
    { label: 'Daily 6 AM', icon: 'pi pi-sun', cron: '0 6 * * *', description: 'Every day at 6:00 AM' },
    { label: 'Daily 9 AM', icon: 'pi pi-clock', cron: '0 9 * * *', description: 'Every day at 9:00 AM' },
    { label: 'Daily 12 PM', icon: 'pi pi-clock', cron: '0 12 * * *', description: 'Every day at 12:00 PM' },
    { label: 'Daily 6 PM', icon: 'pi pi-moon', cron: '0 18 * * *', description: 'Every day at 6:00 PM' },
    { label: 'Daily 9 PM', icon: 'pi pi-moon', cron: '0 21 * * *', description: 'Every day at 9:00 PM' },
    { label: 'Weekdays 9 AM', icon: 'pi pi-briefcase', cron: '0 9 * * 1-5', description: 'Monday to Friday at 9:00 AM' },
    { label: 'Monday 9 AM', icon: 'pi pi-calendar', cron: '0 9 * * 1', description: 'Every Monday at 9:00 AM' },
    { label: 'Friday 6 PM', icon: 'pi pi-calendar', cron: '0 18 * * 5', description: 'Every Friday at 6:00 PM' },
    { label: 'Sunday Midnight', icon: 'pi pi-calendar', cron: '0 0 * * 0', description: 'Every Sunday at midnight' },
  ];

  selectedPreset: CronPreset | null = null;

  environments = [
    { label: 'Local', value: 'local' },
    { label: 'Staging', value: 'staging' },
    { label: 'Production', value: 'production' },
  ];

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
    this.loadSchedules();
  }

  ngOnDestroy() {
    if (this.currentRunId()) {
      this.executionService.disconnectFromRun();
    }
    this.scriptRegistrySubscription?.unsubscribe();
    this.stopTimer();
  }

  // ---- Keyboard Shortcuts ----
  @HostListener('document:keydown', ['$event'])
  handleKeyboardShortcut(event: KeyboardEvent) {
    // Ctrl+Enter = Run Selected
    if (event.ctrlKey && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (this.selectedCount > 0 && !this.running()) {
        this.openRunConfirm();
      }
    }
    // Ctrl+Shift+S = Schedule
    if (event.ctrlKey && event.shiftKey && event.key === 'S') {
      event.preventDefault();
      if (this.selectedCount > 0 && !this.running()) {
        this.openScheduleDialog();
      }
    }
  }

  // ---- Script Selection ----

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

  runIndividualScript(event: Event, scriptId: number) {
    event.stopPropagation();
    if (!this.running()) {
      this.scripts.update(list => list.map(s => ({ ...s, selected: s.id === scriptId })));
      this.openRunConfirm();
    }
  }

  // ---- Run Confirmation ----

  openRunConfirm() {
    this.runName = `Run ${new Date().toISOString().replace('T', ' ').substring(0, 19)}`;
    this.showRunConfirm = true;
  }

  confirmAndRun() {
    this.showRunConfirm = false;
    this.executeRun();
  }

  cancelRunConfirm() {
    this.showRunConfirm = false;
  }

  // ---- Run Execution ----

  runSelected() {
    this.openRunConfirm();
  }

  private executeRun() {
    if (!this.auth.canEdit()) return;
    const scriptIds = this.selectedScripts.map(s => s.id);
    if (scriptIds.length === 0) return;

    this.running.set(true);
    this.logs.set([]);
    this.runStatus.set('running');
    this.startTimer();

    this.messageService.add({ severity: 'info', summary: 'Execution Started', detail: `Running ${scriptIds.length} script(s)...` });

    this.executionService.runScripts(scriptIds, this.runName || undefined).subscribe({
      next: (res) => {
        this.currentRunId.set(res.runId);
        this.logs.update(l => [...l, `▶ Execution started (Run #${res.runId})`]);
        this.logs.update(l => [...l, `  Running ${scriptIds.length} script(s)...`]);
        this.logs.update(l => [...l, '']);

        this.executionService.connectToRun(res.runId);

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
            this.stopTimer();
            clearInterval(checkInterval);

            if (status === 'completed' || status === 'passed') {
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
        this.stopTimer();
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
        this.stopTimer();
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
    this.elapsedSeconds = 0;
  }

  // ---- Timer ----

  private startTimer() {
    this.elapsedSeconds = 0;
    this.stopTimer();
    this.timerInterval = setInterval(() => {
      this.elapsedSeconds++;
    }, 1000);
  }

  private stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  formatElapsed(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  // ---- Download Logs ----

  downloadLogs() {
    const content = this.logs().join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const runId = this.currentRunId();
    a.download = `execution-log${runId ? '-run-' + runId : ''}-${new Date().toISOString().split('T')[0]}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    this.messageService.add({ severity: 'info', summary: 'Downloaded', detail: 'Log file saved' });
  }

  // ---- Schedule Dialog ----

  openScheduleDialog() {
    this.scheduleName = `Scheduled ${this.selectedCount} script(s)`;
    this.scheduleType = 'recurring';
    this.scheduleDate = null;
    this.minScheduleDate = new Date();
    this.scheduleCron = '';
    this.scheduleDescription = '';
    this.scheduleEnvironment = 'local';
    this.selectedPreset = null;
    this.savingSchedule = false;
    this.showScheduleDialog = true;
  }

  selectCronPreset(preset: CronPreset) {
    this.selectedPreset = preset;
    this.scheduleCron = preset.cron;
  }

  getCronDescription(): string {
    if (this.selectedPreset && this.selectedPreset.cron === this.scheduleCron) {
      return this.selectedPreset.description;
    }
    if (!this.scheduleCron) return '';
    const found = this.cronPresets.find(p => p.cron === this.scheduleCron);
    return found ? found.description : `Custom: ${this.scheduleCron}`;
  }

  saveSchedule() {
    if (!this.scheduleName.trim()) {
      this.messageService.add({ severity: 'warn', summary: 'Missing Fields', detail: 'Name is required' });
      return;
    }

    let cronExpr = this.scheduleCron.trim();
    let isOneTime = false;

    if (this.scheduleType === 'once') {
      if (!this.scheduleDate) {
        this.messageService.add({ severity: 'warn', summary: 'Missing Fields', detail: 'Please select a date and time' });
        return;
      }
      isOneTime = true;
      const d = this.scheduleDate;
      cronExpr = `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
    } else {
      if (!cronExpr) {
        this.messageService.add({ severity: 'warn', summary: 'Missing Fields', detail: 'Cron expression is required' });
        return;
      }
    }

    this.savingSchedule = true;
    const scriptIds = this.selectedScripts.map(s => s.id);

    this.executionService.createSchedule({
      name: this.scheduleName.trim(),
      scriptIds,
      cronExpression: cronExpr,
      environment: this.scheduleEnvironment,
      description: this.scheduleDescription.trim() || undefined,
      isOneTime,
    }).subscribe({
      next: (created) => {
        this.savingSchedule = false;
        this.showScheduleDialog = false;
        this.messageService.add({
          severity: 'success',
          summary: 'Schedule Created',
          detail: `"${created.name}" scheduled — ${this.getCronDescription()}`,
        });
        this.loadSchedules();
      },
      error: (err) => {
        this.savingSchedule = false;
        this.messageService.add({
          severity: 'error',
          summary: 'Failed',
          detail: err.error?.error || 'Could not create schedule',
        });
      },
    });
  }

  // ---- Scheduled Runs Panel ----

  toggleSchedulesPanel() {
    this.showSchedulesPanel = !this.showSchedulesPanel;
    if (this.showSchedulesPanel) {
      this.loadSchedules();
    }
  }

  loadSchedules() {
    this.loadingSchedules = true;
    this.executionService.getSchedules().subscribe({
      next: (data) => {
        this.schedules.set(data);
        this.loadingSchedules = false;
      },
      error: () => {
        this.loadingSchedules = false;
      },
    });
  }

  toggleScheduleActive(schedule: ScheduledRun) {
    this.executionService.updateSchedule(schedule.id, { isActive: !schedule.isActive }).subscribe({
      next: () => {
        this.loadSchedules();
        this.messageService.add({
          severity: 'info',
          summary: schedule.isActive ? 'Schedule Paused' : 'Schedule Activated',
          detail: `"${schedule.name}" is now ${schedule.isActive ? 'paused' : 'active'}`,
        });
      },
      error: () => {
        this.messageService.add({ severity: 'error', summary: 'Error', detail: 'Failed to update schedule' });
      },
    });
  }

  deleteSchedule(schedule: ScheduledRun) {
    this.executionService.deleteSchedule(schedule.id).subscribe({
      next: () => {
        this.loadSchedules();
        this.messageService.add({ severity: 'info', summary: 'Deleted', detail: `Schedule "${schedule.name}" removed` });
      },
      error: () => {
        this.messageService.add({ severity: 'error', summary: 'Error', detail: 'Failed to delete schedule' });
      },
    });
  }

  formatDate(dateStr?: string): string {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  // ---- Helpers ----

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
