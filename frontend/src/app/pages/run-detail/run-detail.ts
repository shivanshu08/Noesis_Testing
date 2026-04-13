import { Component, OnInit, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { TableModule } from 'primeng/table';
import { TabsModule } from 'primeng/tabs';
import { TooltipModule } from 'primeng/tooltip';
import { ProgressBarModule } from 'primeng/progressbar';
import { ExecutionService } from '../../services/execution.service';
import { ExecutionRun, ExecutionLog, ExecutionArtifact } from '../../models/interfaces';
import { AuthService } from '../../services/auth.service';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

@Component({
  selector: 'app-run-detail',
  standalone: true,
  imports: [CommonModule, RouterModule, CardModule, ButtonModule, TagModule, TableModule, TabsModule, TooltipModule, ProgressBarModule],
  templateUrl: './run-detail.html',
  styleUrl: './run-detail.scss',
})
export class RunDetail implements OnInit, OnDestroy {
  run = signal<ExecutionRun | null>(null);
  logs = signal<ExecutionLog[]>([]);
  liveLogs = signal<string[]>([]);
  artifacts = signal<ExecutionArtifact[]>([]);
  loading = signal(true);
  runId = 0;

  constructor(
    private route: ActivatedRoute,
    private executionService: ExecutionService,
    public auth: AuthService
  ) {}

  ngOnInit() {
    this.runId = Number(this.route.snapshot.paramMap.get('id'));
    this.loadRunDetails();
    this.loadLogs();
    this.loadArtifacts();
  }

  ngOnDestroy() {
    this.executionService.disconnectFromRun();
  }

  loadRunDetails() {
    this.loading.set(true);
    this.executionService.getRunDetails(this.runId).subscribe({
      next: (data) => {
        this.run.set(data);
        this.loading.set(false);

        if (data.status === 'running') {
          this.executionService.connectToRun(this.runId);
        }
      },
      error: () => this.loading.set(false),
    });
  }

  loadLogs() {
    this.executionService.getLogs(this.runId).subscribe({
      next: (data) => this.logs.set(data),
    });
  }

  loadArtifacts() {
    this.executionService.getArtifacts(this.runId).subscribe({
      next: (data) => this.artifacts.set(this.filterArtifacts(data)),
    });
  }

  private filterArtifacts(artifacts: ExecutionArtifact[]): ExecutionArtifact[] {
    const excludedFileNames = new Set(['emailable-report.html', 'index.html']);
    return artifacts.filter((artifact) => {
      const fileName = artifact.fileName || '';
      const baseName = fileName.split(/[/\\]/).pop()?.toLowerCase() || '';
      return !excludedFileNames.has(baseName);
    });
  }

  downloadArtifact(artifact: ExecutionArtifact) {
    this.executionService.downloadArtifactBlob(artifact.id, artifact.fileName);
  }

  stopRun() {
    if (!this.auth.canEdit()) return;
    this.executionService.stopRun(this.runId).subscribe({
      next: () => this.loadRunDetails(),
    });
  }

  getStatusSeverity(status: string): 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' {
    switch (status) {
      case 'passed': return 'success';
      case 'failed': return 'danger';
      case 'running': return 'warn';
      case 'queued': return 'info';
      case 'stopped': return 'secondary';
      case 'error': return 'danger';
      default: return 'secondary';
    }
  }

  formatDate(date: string | undefined): string {
    if (!date) return '-';
    return new Date(date).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  formatDuration(seconds: number | null | undefined): string {
    if (!seconds) return '-';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  get passRate(): number {
    const r = this.run();
    if (!r || !r.totalScripts) return 0;
    return Math.round(((r.passedCount || 0) / r.totalScripts) * 100);
  }

  getTimelineWidth(durationMs: number | undefined | null): number {
    const r = this.run();
    if (!r || !r.results || !durationMs) return 10;
    const maxDuration = Math.max(...r.results.map(res => res.durationMs || 0));
    if (maxDuration === 0) return 50;
    return Math.max(10, Math.round((durationMs / maxDuration) * 100));
  }

  getRunMetadataValue(field: keyof NonNullable<ExecutionRun['runMetadata']>): string {
    const value = this.run()?.runMetadata?.[field];
    if (value === null || value === undefined || value === '') {
      return '-';
    }
    return String(value);
  }

  downloadPdf() {
    try {
      const r = this.run();
      if (!r) return;

      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.width;
      
      // Brand Header (Drogevate Testing)
      doc.setFillColor(15, 23, 42); // slate-900
      doc.rect(0, 0, pageWidth, 28, 'F');
      
      doc.setFontSize(18);
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.text('Drogevate Testing', 14, 18);
      
      // Report Title
      doc.setFontSize(14);
      doc.setTextColor(40, 40, 40);
      doc.text(`Noesis Run Report #${r.id}`, 14, 40);
      
      doc.setFontSize(11);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(100, 100, 100);
      doc.text(r.runName || 'Manual Run', 14, 46);
      
      // Meta Information Box
      doc.setDrawColor(226, 232, 240); // slate-200
      doc.setFillColor(248, 250, 252); // slate-50
      doc.roundedRect(14, 52, pageWidth - 28, 22, 3, 3, 'FD');

      doc.setFontSize(9);
      doc.setTextColor(71, 85, 105); // slate-600
      doc.setFont('helvetica', 'bold');
      
      const statusText = `Status: ${(r.status || 'unknown').toUpperCase()}`;
      doc.text(statusText, 20, 60);
      doc.setFont('helvetica', 'normal');
      doc.text(`Total: ${r.totalScripts || 0} | Passed: ${r.passedCount || 0} | Failed: ${r.failedCount || 0}`, 20, 65);
      doc.text(`Duration: ${this.formatDuration(r.durationMs ? r.durationMs / 1000 : null)}`, 20, 70);

      doc.text(`Started: ${this.formatDate(r.startedAt)}`, 110, 60);
      doc.text(`Pass Rate: ${this.passRate}%`, 110, 65);
      doc.text(`Triggered By: ${r.triggeredBy || '-'}`, 110, 70);

      let startY = 86;

      // Results Table
      if (r.results && r.results.length > 0) {
        doc.setFontSize(13);
        doc.setTextColor(15, 23, 42);
        doc.setFont('helvetica', 'bold');
        doc.text('Test Results', 14, startY);
        startY += 6;

        const tableBody = r.results.map(res => [
          res.scriptName || `Script #${res.scriptId}`,
          (res.status || 'unknown').toUpperCase(),
          this.formatDuration(res.durationMs ? res.durationMs / 1000 : null),
          res.errorMessage || '-'
        ]);

        autoTable(doc, {
          startY: startY,
          head: [['Script', 'Status', 'Duration', 'Error']],
          body: tableBody,
          theme: 'grid',
          headStyles: { fillColor: [71, 85, 105], textColor: 255, fontSize: 9 },
          bodyStyles: { fontSize: 8.5 },
          alternateRowStyles: { fillColor: [248, 250, 252] },
          styles: { cellPadding: 3 }
        });
        
        startY = (doc as any).lastAutoTable.finalY + 16;
      }

      // Logs
      const logData = this.logs();
      if (logData && logData.length > 0) {
        if (startY > doc.internal.pageSize.height - 30) {
          doc.addPage();
          startY = 20;
        }
        
        doc.setFontSize(13);
        doc.setTextColor(15, 23, 42);
        doc.setFont('helvetica', 'bold');
        doc.text('Execution Logs', 14, startY);
        startY += 6;

        const logLines = logData.map(l => {
          const time = new Date(l.timestamp).toLocaleTimeString();
          return `[${time}] [${(l.level || 'info').toUpperCase()}] ${l.message || ''}`;
        });
        
        autoTable(doc, {
          startY: startY,
          body: logLines.map(l => [l]),
          theme: 'plain',
          styles: { 
            fontSize: 7.5, 
            cellPadding: 1.5, 
            overflow: 'linebreak',
            font: 'courier'
          }
        });
      }

      // Add page numbers
      const pageCount = doc.internal.pages.length - 1;
      doc.setFontSize(8);
      doc.setTextColor(150);
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.text(`Page ${i} of ${pageCount}`, pageWidth - 30, doc.internal.pageSize.height - 10);
      }

      doc.save(`Noesis_Run_Report_${r.id}.pdf`);
    } catch (e: any) {
      console.error(e);
      alert('Error generating PDF: ' + e.message);
    }
  }
}
