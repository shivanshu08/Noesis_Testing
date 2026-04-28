import { Component, OnInit, OnDestroy, signal, ViewChild, ElementRef, HostListener, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
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
import { Script, ScriptCategory, ScheduledRun, ExecutionArtifact, ExecutionRun } from '../../models/interfaces';
import { AuthService } from '../../services/auth.service';
import { MessageService } from 'primeng/api';
import { Subscription } from 'rxjs';

interface SelectableScript extends Script {
  selected: boolean;
  dependencies: number[];
  dependencyCount: number;
  dependentCount: number;
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
  private router = inject(Router);
  @ViewChild('logContainer') logContainer!: ElementRef;

  scripts = signal<SelectableScript[]>([]);
  categories = signal<ScriptCategory[]>([]);
  logs = signal<string[]>([]);
  loading = signal(true);
  running = signal(false);
  currentRunId = signal<number | null>(null);
  runStatus = signal<string>('');
  schedules = signal<ScheduledRun[]>([]);
  artifacts = signal<ExecutionArtifact[]>([]);
  latestRunDetails = signal<ExecutionRun | null>(null);

  selectedCategory: number | null = null;
  searchTerm = '';
  autoScroll = true;
  private scriptRegistrySubscription?: Subscription;

  // Execution Progress
  executionProgress = signal(0);
  completedScripts = signal(0);
  totalExecutionScripts = signal(0);
  currentExecutingScript = signal('');

  // Run Confirmation Dialog
  showRunConfirm = false;
  runName = '';
  plannedScriptOrderIds: number[] = [];
  autoIncludedDependencyIds: number[] = [];
  dependencyCyclePathIds: number[] = [];

  // Dependency Configuration Dialog
  showDependencyDialog = false;
  dependencyTargetScriptId: number | null = null;
  dependencyDraftIds: number[] = [];
  savingDependencies = false;

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

  // Artifact mail dialog
  showMailArtifactsDialog = false;
  mailRecipients = '';
  mailSubject = '';
  mailMessage = '';
  mailArtifactIds: number[] = [];
  mailingArtifacts = false;

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
    { label: 'Validation', value: 'validation' },
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

  get dependencyTargetScript(): SelectableScript | null {
    const scriptId = this.dependencyTargetScriptId;
    if (!scriptId) return null;
    return this.scripts().find((script) => script.id === scriptId) || null;
  }

  get dependencyCandidates(): SelectableScript[] {
    const targetId = this.dependencyTargetScriptId;
    if (!targetId) return [];

    return this.scripts()
      .filter((script) => script.id !== targetId && script.isActive)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get hasDependencyCycleInSelection(): boolean {
    return this.dependencyCyclePathIds.length > 0;
  }

  get plannedScriptTotalCount(): number {
    return this.plannedScriptOrderIds.length > 0 ? this.plannedScriptOrderIds.length : this.selectedCount;
  }

  get autoIncludedDependencyCount(): number {
    return this.autoIncludedDependencyIds.length;
  }

  get dependencyCyclePathLabel(): string {
    if (this.dependencyCyclePathIds.length === 0) {
      return '';
    }

    return this.dependencyCyclePathIds.map((id) => this.getScriptNameById(id)).join(' -> ');
  }

  get confirmPreviewRows(): Array<{ scriptId: number; scriptName: string; isAutoDependency: boolean }> {
    const orderedIds = this.plannedScriptOrderIds.length > 0
      ? this.plannedScriptOrderIds
      : this.selectedScripts.map((script) => script.id);
    const autoDependencySet = new Set(this.autoIncludedDependencyIds);

    return orderedIds.map((scriptId) => ({
      scriptId,
      scriptName: this.getScriptNameById(scriptId),
      isAutoDependency: autoDependencySet.has(scriptId),
    }));
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

  openDependencyDialog(event: Event, scriptId: number) {
    event.stopPropagation();
    if (!this.auth.canEdit()) return;

    const targetScript = this.scripts().find((script) => script.id === scriptId);
    if (!targetScript) return;

    this.dependencyTargetScriptId = scriptId;
    this.dependencyDraftIds = [...(targetScript.dependencies || [])];
    this.savingDependencies = false;
    this.showDependencyDialog = true;
  }

  closeDependencyDialog() {
    if (this.savingDependencies) return;
    this.showDependencyDialog = false;
    this.dependencyTargetScriptId = null;
    this.dependencyDraftIds = [];
  }

  isDependencyDraftSelected(scriptId: number): boolean {
    return this.dependencyDraftIds.includes(scriptId);
  }

  toggleDependencyDraft(scriptId: number, checked: boolean) {
    const next = new Set(this.dependencyDraftIds);
    if (checked) {
      next.add(scriptId);
    } else {
      next.delete(scriptId);
    }
    this.dependencyDraftIds = Array.from(next);
  }

  saveDependencyDialog() {
    const targetScript = this.dependencyTargetScript;
    if (!targetScript) {
      this.closeDependencyDialog();
      return;
    }

    const dependencyIds = this.dependencyDraftIds
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0 && id !== targetScript.id);
    this.savingDependencies = true;

    this.scriptService.updateScriptDependencies(targetScript.id, dependencyIds).subscribe({
      next: () => {
        this.savingDependencies = false;
        this.showDependencyDialog = false;
        this.dependencyTargetScriptId = null;
        this.dependencyDraftIds = [];

        this.scripts.update((list) => list.map((script) => (
          script.id === targetScript.id
            ? { ...script, dependencies: [...dependencyIds], dependencyCount: dependencyIds.length }
            : script
        )));
        this.recalculateDependentCounts();

        this.messageService.add({
          severity: 'success',
          summary: 'Dependencies Updated',
          detail: `"${targetScript.name}" now has ${dependencyIds.length} prerequisite script${dependencyIds.length === 1 ? '' : 's'}.`,
        });
      },
      error: (error) => {
        this.savingDependencies = false;
        const cycleLabels = Array.isArray(error?.error?.cycleLabels)
          ? error.error.cycleLabels.join(' -> ')
          : '';
        const detail = cycleLabels
          ? `Circular dependency: ${cycleLabels}`
          : (error?.error?.error || 'Failed to update script dependencies.');

        this.messageService.add({
          severity: 'error',
          summary: 'Dependency Update Failed',
          detail,
        });
      },
    });
  }

  // ---- Run Confirmation ----

  openRunConfirm() {
    const selectedIds = this.selectedScripts.map((script) => script.id);
    const plan = this.computeLocalDependencyPlan(selectedIds);

    this.runName = `Run ${new Date().toISOString().replace('T', ' ').substring(0, 19)}`;
    this.plannedScriptOrderIds = plan.orderedScriptIds.length > 0 ? plan.orderedScriptIds : selectedIds;
    this.autoIncludedDependencyIds = plan.autoIncludedDependencyIds;
    this.dependencyCyclePathIds = plan.cyclePath;
    this.showRunConfirm = true;
  }

  confirmAndRun() {
    if (this.hasDependencyCycleInSelection) {
      this.messageService.add({
        severity: 'error',
        summary: 'Dependency Cycle Detected',
        detail: this.dependencyCyclePathLabel || 'Please resolve circular script dependencies before running.',
      });
      return;
    }
    this.showRunConfirm = false;
    this.executeRun();
  }

  cancelRunConfirm() {
    this.showRunConfirm = false;
    this.plannedScriptOrderIds = [];
    this.autoIncludedDependencyIds = [];
    this.dependencyCyclePathIds = [];
  }

  // ---- Run Execution ----

  runSelected() {
    this.openRunConfirm();
  }

  private executeRun() {
    if (!this.auth.canEdit()) return;
    const selectedScriptIds = this.selectedScripts.map((script) => script.id);
    if (selectedScriptIds.length === 0) return;

    const localPlan = this.computeLocalDependencyPlan(selectedScriptIds);
    if (localPlan.cyclePath.length > 0) {
      this.messageService.add({
        severity: 'error',
        summary: 'Dependency Cycle Detected',
        detail: localPlan.cyclePath.map((id) => this.getScriptNameById(id)).join(' -> '),
      });
      return;
    }

    const optimisticTotalScripts = localPlan.orderedScriptIds.length > 0
      ? localPlan.orderedScriptIds.length
      : selectedScriptIds.length;
    this.plannedScriptOrderIds = localPlan.orderedScriptIds.length > 0
      ? localPlan.orderedScriptIds
      : selectedScriptIds;
    this.autoIncludedDependencyIds = localPlan.autoIncludedDependencyIds;
    this.dependencyCyclePathIds = [];

    this.running.set(true);
    this.logs.set([]);
    this.runStatus.set('running');
    this.startTimer();

    // Initialize progress tracking
    this.totalExecutionScripts.set(optimisticTotalScripts);
    this.completedScripts.set(0);
    this.executionProgress.set(0);
    this.currentExecutingScript.set('');
    this.artifacts.set([]);
    this.latestRunDetails.set(null);

    const localDependencyCount = localPlan.autoIncludedDependencyIds.length;
    this.messageService.add({
      severity: 'info',
      summary: 'Execution Started',
      detail: localDependencyCount > 0
        ? `Running ${optimisticTotalScripts} script(s) including ${localDependencyCount} dependency script${localDependencyCount === 1 ? '' : 's'}.`
        : `Running ${optimisticTotalScripts} script(s)...`,
    });

    this.executionService.runScripts(selectedScriptIds, this.runName || undefined).subscribe({
      next: (res) => {
        const backendResolvedIds = Array.isArray(res.resolvedScriptIds) ? res.resolvedScriptIds : [];
        const resolvedScriptIds = backendResolvedIds.length > 0
          ? backendResolvedIds
          : this.plannedScriptOrderIds;
        const backendAutoDependencyIds = Array.isArray(res.autoIncludedDependencyIds)
          ? res.autoIncludedDependencyIds
          : this.autoIncludedDependencyIds;
        const totalScripts = Number.isFinite(res.totalScripts) && res.totalScripts > 0
          ? res.totalScripts
          : (resolvedScriptIds.length > 0 ? resolvedScriptIds.length : optimisticTotalScripts);

        this.totalExecutionScripts.set(totalScripts);
        this.plannedScriptOrderIds = resolvedScriptIds.length > 0 ? resolvedScriptIds : this.plannedScriptOrderIds;
        this.autoIncludedDependencyIds = backendAutoDependencyIds;

        this.currentRunId.set(res.runId);
        this.logs.update(l => [...l, `▶ Execution started (Run #${res.runId})`]);
        this.logs.update(l => [...l, `  Running ${totalScripts} script(s)...`]);
        if (backendAutoDependencyIds.length > 0) {
          const dependencyNamePreview = backendAutoDependencyIds
            .slice(0, 4)
            .map((id) => this.getScriptNameById(id))
            .join(', ');
          const remainingCount = backendAutoDependencyIds.length - Math.min(backendAutoDependencyIds.length, 4);
          const suffix = remainingCount > 0 ? ` (+${remainingCount} more)` : '';

          this.logs.update(l => [
            ...l,
            `  Auto-included dependencies (${backendAutoDependencyIds.length}): ${dependencyNamePreview}${suffix}`,
          ]);
        }
        this.logs.update(l => [...l, '']);

        if (backendAutoDependencyIds.length > 0) {
          this.messageService.add({
            severity: 'info',
            summary: 'Dependencies Auto-Included',
            detail: `${backendAutoDependencyIds.length} prerequisite script${backendAutoDependencyIds.length === 1 ? '' : 's'} were added automatically.`,
          });
        }

        this.executionService.connectToRun(res.runId);

        const checkInterval = setInterval(() => {
          const serviceLogs = this.executionService.liveLogs();
          if (serviceLogs.length > 0) {
            const newLines = serviceLogs.map(l => l.message);
            this.logs.update(existing => [...existing, ...newLines]);
            this.executionService.liveLogs.set([]);

            // Parse lines for progress tracking
            for (const line of newLines) {
              if (line.includes('PASSED') || line.includes('FAILED') || line.includes('BUILD SUCCESS') || line.includes('BUILD FAILURE')) {
                this.completedScripts.update(c => {
                  const next = c + 1;
                  const total = this.totalExecutionScripts();
                  this.executionProgress.set(total > 0 ? Math.min(Math.round((next / total) * 100), 100) : 0);
                  return next;
                });
              }
              // Detect running script name
              const runMatch = line.match(/^▶\s+Running:\s+(.+)/);
              if (runMatch) {
                this.currentExecutingScript.set(runMatch[1].trim());
              }
            }

            if (this.autoScroll) {
              setTimeout(() => this.scrollToBottom(), 50);
            }
          }
          const status = this.executionService.activeRunStatus();
          if (status && status !== 'running') {
            this.running.set(false);
            this.runStatus.set(status);
            this.stopTimer();
            this.executionProgress.set(100);
            this.currentExecutingScript.set('');
            clearInterval(checkInterval);

            if (status === 'completed' || status === 'passed' || status === 'failed') {
              const logText = this.logs().join('\n');
              const passedMatch = logText.match(/(\d+)\s+passed/i);
              const failedMatch = logText.match(/(\d+)\s+failed/i);
              const passed = passedMatch ? parseInt(passedMatch[1]) : 0;
              const plannedTotal = this.totalExecutionScripts();
              const failed = failedMatch ? parseInt(failedMatch[1]) : Math.max(plannedTotal - passed, 0);
              const total = Math.max(passed + failed, plannedTotal);
              this.messageService.add({ severity: status === 'failed' ? 'error' : 'success', summary: 'Execution Completed', detail: `Total: ${total}, Passed: ${passed}, Failed: ${failed}` });

              const readyArtifacts = this.executionService.artifactsReady();
              if (readyArtifacts.length > 0) {
                this.artifacts.set(readyArtifacts);
              } else {
                this.executionService.getArtifacts(res.runId).subscribe(data => this.artifacts.set(data));
              }

              this.loadLatestRunDetails(res.runId);
            } else if (status === 'error') {
              this.messageService.add({ severity: 'error', summary: 'Execution Failed', detail: 'An error occurred during execution' });
              this.loadLatestRunDetails(res.runId);
            } else if (status === 'stopped') {
              this.messageService.add({ severity: 'warn', summary: 'Execution Stopped', detail: 'The execution was manually stopped' });
              this.loadLatestRunDetails(res.runId);
            }
          }
        }, 500);
      },
      error: (err) => {
        this.logs.update(l => [...l, `✗ Error: ${err.error?.message || 'Failed to start execution'}`]);
        this.running.set(false);
        this.runStatus.set('error');
        this.stopTimer();
        this.executionProgress.set(0);
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
    this.artifacts.set([]);
    this.latestRunDetails.set(null);
    this.plannedScriptOrderIds = [];
    this.autoIncludedDependencyIds = [];
    this.dependencyCyclePathIds = [];
  }

  // ---- Artifacts & Completion ----
  
  viewRunDetails() {
    if (this.currentRunId()) {
      this.router.navigate(['/run', this.currentRunId()]);
    }
  }

  canViewDetailedReport(): boolean {
    const runId = this.currentRunId();
    if (!runId || this.running()) {
      return false;
    }

    return ['passed', 'failed', 'completed', 'stopped', 'error'].includes(this.runStatus());
  }
  
  downloadArtifact(artifact: ExecutionArtifact) {
    this.executionService.downloadArtifactBlob(artifact.id, artifact.fileName);
  }
  
  downloadAllArtifacts() {
    this.artifacts().forEach((artifact, index) => {
      setTimeout(() => {
        this.downloadArtifact(artifact);
      }, index * 500); // Stagger downloads slightly
    });
  }

  openMailArtifactsDialog() {
    const runId = this.currentRunId();
    const artifacts = this.artifacts();
    if (!runId || artifacts.length === 0) {
      this.messageService.add({ severity: 'warn', summary: 'No Artifacts', detail: 'There are no artifacts available to mail yet.' });
      return;
    }

    this.mailArtifactIds = artifacts.map((artifact) => artifact.id);
    this.mailRecipients = '';
    this.mailSubject = `Noesis artifacts for Run #${runId}`;
    this.mailMessage = 'Please find the selected execution artifacts attached.';
    this.mailingArtifacts = false;
    this.showMailArtifactsDialog = true;
  }

  closeMailArtifactsDialog() {
    if (this.mailingArtifacts) return;
    this.showMailArtifactsDialog = false;
  }

  isMailArtifactSelected(artifactId: number): boolean {
    return this.mailArtifactIds.includes(artifactId);
  }

  toggleMailArtifact(artifactId: number, checked: boolean) {
    const next = new Set(this.mailArtifactIds);
    if (checked) {
      next.add(artifactId);
    } else {
      next.delete(artifactId);
    }
    this.mailArtifactIds = Array.from(next);
  }

  toggleAllMailArtifacts() {
    const artifacts = this.artifacts();
    this.mailArtifactIds = this.mailArtifactIds.length === artifacts.length
      ? []
      : artifacts.map((artifact) => artifact.id);
  }

  get selectedMailArtifactCount(): number {
    return this.mailArtifactIds.length;
  }

  get mailRecipientList(): string[] {
    return this.mailRecipients
      .split(/[,\n;]/)
      .map((recipient) => recipient.trim())
      .filter(Boolean);
  }

  sendArtifactMail() {
    const runId = this.currentRunId();
    if (!runId) return;

    const recipients = this.mailRecipientList;
    const invalidRecipient = recipients.find((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
    if (recipients.length === 0) {
      this.messageService.add({ severity: 'warn', summary: 'Recipients Required', detail: 'Enter at least one email address.' });
      return;
    }
    if (invalidRecipient) {
      this.messageService.add({ severity: 'error', summary: 'Invalid Email', detail: invalidRecipient });
      return;
    }
    if (this.mailArtifactIds.length === 0) {
      this.messageService.add({ severity: 'warn', summary: 'Artifacts Required', detail: 'Select at least one artifact to attach.' });
      return;
    }

    this.mailingArtifacts = true;
    this.executionService.mailArtifacts(runId, {
      recipients,
      artifactIds: this.mailArtifactIds,
      subject: this.mailSubject.trim() || undefined,
      message: this.mailMessage.trim() || undefined,
    }).subscribe({
      next: (response) => {
        this.mailingArtifacts = false;
        this.showMailArtifactsDialog = false;
        this.messageService.add({
          severity: 'success',
          summary: 'Artifacts Mailed',
          detail: response.message || 'Selected artifacts were mailed successfully.',
        });
      },
      error: (error) => {
        this.mailingArtifacts = false;
        this.messageService.add({
          severity: 'error',
          summary: 'Mail Failed',
          detail: error?.error?.error || 'Could not mail artifacts.',
        });
      },
    });
  }

  getRunStatusSeverity(status: string): 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' {
    switch ((status || '').toLowerCase()) {
      case 'passed':
      case 'completed':
        return 'success';
      case 'failed':
      case 'error':
        return 'danger';
      case 'running':
        return 'warn';
      case 'stopped':
        return 'secondary';
      default:
        return 'info';
    }
  }

  getRunMetadataValue(field: keyof NonNullable<ExecutionRun['runMetadata']>): string {
    const metadata = this.latestRunDetails()?.runMetadata;
    const value = metadata?.[field];
    if (value === null || value === undefined || value === '') {
      return '-';
    }

    return String(value);
  }

  getArtifactsByType(type: string): ExecutionArtifact[] {
    const expected = (type || '').trim().toLowerCase();
    return this.artifacts().filter((artifact) => String(artifact.artifactType || '').toLowerCase() === expected);
  }

  formatBytes(value?: number): string {
    if (!value || value <= 0) return '-';
    if (value < 1024) return `${value} B`;
    const kb = value / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(2)} MB`;
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

  private loadLatestRunDetails(runId: number): void {
    this.executionService.getRunDetails(runId).subscribe({
      next: (details) => this.latestRunDetails.set(details),
    });
  }

  getCategoryName(catId: number): string {
    return this.categories().find(c => c.id === catId)?.name || 'Unknown';
  }

  getScriptNameById(scriptId: number): string {
    return this.scripts().find((script) => script.id === scriptId)?.name || `Script #${scriptId}`;
  }

  private recalculateDependentCounts() {
    this.scripts.update((list) => {
      const dependentCountById = new Map<number, number>();

      for (const script of list) {
        const uniqueDependencies = Array.from(new Set(script.dependencies || []))
          .filter((dependencyId) => Number.isInteger(dependencyId) && dependencyId > 0 && dependencyId !== script.id);

        for (const dependencyId of uniqueDependencies) {
          dependentCountById.set(dependencyId, (dependentCountById.get(dependencyId) || 0) + 1);
        }
      }

      return list.map((script) => {
        const dependencyIds = Array.from(new Set(script.dependencies || []))
          .filter((dependencyId) => Number.isInteger(dependencyId) && dependencyId > 0 && dependencyId !== script.id);

        return {
          ...script,
          dependencies: dependencyIds,
          dependencyCount: dependencyIds.length,
          dependentCount: dependentCountById.get(script.id) || 0,
        };
      });
    });
  }

  private computeLocalDependencyPlan(selectedScriptIdsRaw: number[]): {
    orderedScriptIds: number[];
    autoIncludedDependencyIds: number[];
    cyclePath: number[];
  } {
    const selectedScriptIds = Array.from(
      new Set(
        selectedScriptIdsRaw
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0)
      )
    );
    if (selectedScriptIds.length === 0) {
      return {
        orderedScriptIds: [],
        autoIncludedDependencyIds: [],
        cyclePath: [],
      };
    }

    const scripts = this.scripts();
    const dependencyMap = new Map<number, number[]>();
    for (const script of scripts) {
      const dependencyIds = Array.from(new Set(script.dependencies || []))
        .filter((dependencyId) => Number.isInteger(dependencyId) && dependencyId > 0 && dependencyId !== script.id);
      dependencyMap.set(script.id, dependencyIds);
    }
    for (const selectedId of selectedScriptIds) {
      if (!dependencyMap.has(selectedId)) {
        dependencyMap.set(selectedId, []);
      }
    }

    const selectedPriority = new Map<number, number>();
    selectedScriptIds.forEach((id, index) => selectedPriority.set(id, index));
    const comparator = (a: number, b: number): number => {
      const aPriority = selectedPriority.has(a) ? selectedPriority.get(a)! : Number.MAX_SAFE_INTEGER;
      const bPriority = selectedPriority.has(b) ? selectedPriority.get(b)! : Number.MAX_SAFE_INTEGER;
      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }
      return a - b;
    };

    const state = new Map<number, 0 | 1 | 2>();
    const stack: number[] = [];
    const stackIndex = new Map<number, number>();
    let cyclePath: number[] = [];

    const detectCycle = (scriptId: number): boolean => {
      state.set(scriptId, 1);
      stackIndex.set(scriptId, stack.length);
      stack.push(scriptId);

      const dependencyIds = [...(dependencyMap.get(scriptId) || [])].sort(comparator);
      for (const dependencyId of dependencyIds) {
        if (!dependencyMap.has(dependencyId)) {
          dependencyMap.set(dependencyId, []);
        }

        const depState = state.get(dependencyId) || 0;
        if (depState === 0) {
          if (detectCycle(dependencyId)) {
            return true;
          }
        } else if (depState === 1) {
          const cycleStartIndex = stackIndex.get(dependencyId) ?? 0;
          cyclePath = [...stack.slice(cycleStartIndex), dependencyId];
          return true;
        }
      }

      stack.pop();
      stackIndex.delete(scriptId);
      state.set(scriptId, 2);
      return false;
    };

    for (const selectedId of selectedScriptIds) {
      if ((state.get(selectedId) || 0) === 0 && detectCycle(selectedId)) {
        return {
          orderedScriptIds: [],
          autoIncludedDependencyIds: [],
          cyclePath,
        };
      }
    }

    const visited = new Set<number>();
    const orderedScriptIds: number[] = [];
    const visit = (scriptId: number): void => {
      if (visited.has(scriptId)) return;
      visited.add(scriptId);

      const dependencyIds = [...(dependencyMap.get(scriptId) || [])].sort(comparator);
      for (const dependencyId of dependencyIds) {
        visit(dependencyId);
      }

      orderedScriptIds.push(scriptId);
    };

    for (const selectedId of selectedScriptIds) {
      visit(selectedId);
    }

    const selectedSet = new Set<number>(selectedScriptIds);
    const autoIncludedDependencyIds = orderedScriptIds.filter((id) => !selectedSet.has(id));

    return {
      orderedScriptIds,
      autoIncludedDependencyIds,
      cyclePath: [],
    };
  }

  private loadRegistryData() {
    this.loading.set(true);

    this.scriptService.getCategories().subscribe({
      next: (data) => this.categories.set(data),
    });

    this.scriptService.getScripts().subscribe({
      next: (data) => {
        const previouslySelected = new Set(
          this.scripts()
            .filter((script) => script.selected)
            .map((script) => script.id)
        );

        this.scripts.set(
          data
            .filter((script) => script.isActive)
            .map((script) => {
              const dependencyIds = Array.from(new Set(script.dependencies || []))
                .map((id) => Number(id))
                .filter((id) => Number.isInteger(id) && id > 0 && id !== script.id);

              return {
                ...script,
                selected: previouslySelected.has(script.id),
                dependencies: dependencyIds,
                dependencyCount: typeof script.dependencyCount === 'number' ? script.dependencyCount : dependencyIds.length,
                dependentCount: typeof script.dependentCount === 'number' ? script.dependentCount : 0,
              };
            })
        );
        this.recalculateDependentCounts();
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }
}
