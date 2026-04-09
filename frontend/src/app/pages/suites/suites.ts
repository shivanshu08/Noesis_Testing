import { Component, OnInit, signal } from '@angular/core';
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
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService } from 'primeng/api';
import { SuiteService } from '../../services/suite.service';
import { ScriptService } from '../../services/script.service';
import { ExecutionService } from '../../services/execution.service';
import { TestSuite, Script } from '../../models/interfaces';
import { Router } from '@angular/router';

@Component({
  selector: 'app-suites',
  standalone: true,
  imports: [
    CommonModule, FormsModule, CardModule, ButtonModule, TableModule,
    DialogModule, InputTextModule, TextareaModule, MultiSelectModule,
    TagModule, TooltipModule, ConfirmDialogModule,
  ],
  providers: [ConfirmationService],
  templateUrl: './suites.html',
  styleUrl: './suites.scss',
})
export class Suites implements OnInit {
  suites = signal<TestSuite[]>([]);
  allScripts = signal<Script[]>([]);
  loading = signal(true);

  dialogVisible = false;
  editing = false;
  editId: number | null = null;

  form = { name: '', description: '', scriptIds: [] as number[] };

  constructor(
    private suiteService: SuiteService,
    private scriptService: ScriptService,
    private executionService: ExecutionService,
    private confirmService: ConfirmationService,
    private router: Router,
  ) {}

  ngOnInit() {
    this.loadSuites();
    this.scriptService.getScripts().subscribe({
      next: (data) => this.allScripts.set(data),
    });
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

  openCreate() {
    this.editing = false;
    this.editId = null;
    this.form = { name: '', description: '', scriptIds: [] };
    this.dialogVisible = true;
  }

  openEdit(suite: TestSuite) {
    this.editing = true;
    this.editId = suite.id;
    this.form = {
      name: suite.name,
      description: suite.description || '',
      scriptIds: suite.scripts?.map(s => s.id) || [],
    };
    this.dialogVisible = true;
  }

  saveSuite() {
    if (!this.form.name.trim()) return;

    if (this.editing && this.editId) {
      this.suiteService.updateSuite(this.editId, this.form).subscribe({
        next: () => {
          this.dialogVisible = false;
          this.loadSuites();
        },
      });
    } else {
      this.suiteService.createSuite(this.form).subscribe({
        next: () => {
          this.dialogVisible = false;
          this.loadSuites();
        },
      });
    }
  }

  deleteSuite(suite: TestSuite) {
    this.confirmService.confirm({
      message: `Delete suite "${suite.name}"? This cannot be undone.`,
      header: 'Confirm Delete',
      icon: 'pi pi-trash',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.suiteService.deleteSuite(suite.id).subscribe({
          next: () => this.loadSuites(),
        });
      },
    });
  }

  runSuite(suite: TestSuite) {
    const scriptIds = suite.scripts?.map(s => s.id) || [];
    if (scriptIds.length === 0) return;

    this.executionService.runScripts(scriptIds, suite.name).subscribe({
      next: (res) => {
        this.router.navigate(['/run', res.runId]);
      },
    });
  }
}
