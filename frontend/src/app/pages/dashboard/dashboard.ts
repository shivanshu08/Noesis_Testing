import { Component, OnInit, OnDestroy, signal, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { TableModule } from 'primeng/table';
import { ChartModule } from 'primeng/chart';
import { ExecutionService } from '../../services/execution.service';
import { ScriptService } from '../../services/script.service';
import { AuthService } from '../../services/auth.service';
import { ThemeService } from '../../services/theme.service';
import { DashboardStats, ExecutionRun } from '../../models/interfaces';
import { formatExecutionEnvironmentLabel } from '../../utils/execution-environment';
import { clampPercentage, toPercentage } from '../../utils/percentage';
import { Subscription } from 'rxjs';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterModule, CardModule, ButtonModule, TagModule, TableModule, ChartModule],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard implements OnInit, OnDestroy {
  stats = signal<DashboardStats | null>(null);
  recentRuns = signal<ExecutionRun[]>([]);

  // System Health
  systemHealth = signal<{ api: string; db: string; uptime: number; memoryMB: number; status: string } | null>(null);

  categoryChartData: any;
  historyChartData: any;
  chartOptions: any;
  trendSummary = { total: 0, passed: 0, failed: 0, activeDays: 0 };

  doughnutChartOptions: any;
  
  private statInterval: any;
  private scriptRegistrySubscription?: Subscription;

  constructor(
    private executionService: ExecutionService,
    private scriptService: ScriptService,
    public auth: AuthService,
    public themeService: ThemeService,
    private router: Router,
    private http: HttpClient
  ) {
    effect(() => {
      const isDark = this.themeService.isDarkMode();
      if (this.stats()) {
        this.initCharts();
      }
    });
  }

  ngOnInit() {
    this.loadData();
    this.scriptRegistrySubscription = this.scriptService.scriptRegistryUpdated$.subscribe(() => {
      this.loadData();
    });
    
    // Bulletproof Auto-Refresh: Update entire dashboard every 30 seconds silently
    this.statInterval = setInterval(() => this.loadData(), 30000);
  }

  ngOnDestroy() {
    if (this.statInterval) clearInterval(this.statInterval);
    this.scriptRegistrySubscription?.unsubscribe();
  }

  loadData() {
    this.executionService.getStats().subscribe({
      next: (data) => {
        this.stats.set(data);
        this.initCharts();
      },
      error: () => {},
    });

    this.executionService.getRuns({ limit: 5 }).subscribe({
      next: (data) => this.recentRuns.set(data),
      error: () => {},
    });

    // Fetch system health
    this.http.get<any>(`${environment.apiUrl}/health`).subscribe({
      next: (data) => this.systemHealth.set(data),
      error: () => this.systemHealth.set({ api: 'degraded', db: 'unknown', uptime: 0, memoryMB: 0, status: 'degraded' }),
    });
  }

  formatUptime(seconds: number): string {
    if (!seconds) return '-';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  getPercentage(count: number, total: number | undefined): number {
    return toPercentage(Number(count || 0), Number(total || 0));
  }

  initCharts() {
    const isDark = this.themeService.isDarkMode();
    
    // Use exact hex values because the Canvas API fails to parse deeply nested PrimeNG CSS variables in Dark Mode
    const textColor = isDark ? '#f8fafc' : '#0f172a';
    const textColorSecondary = isDark ? '#94a3b8' : '#64748b'; 
    const surfaceBorder = isDark ? '#334155' : '#e2e8f0';
    const surfaceCard = isDark ? '#1e293b' : '#ffffff';

    // Premium universal tooltip (Sleek slate dark mode look in both themes)
    const tooltipConfig = {
      backgroundColor: 'rgba(15, 23, 42, 0.95)',
      titleColor: '#ffffff',
      bodyColor: '#cbd5e1',
      borderColor: '#334155',
      borderWidth: 1,
      padding: 14,
      boxPadding: 6,
      usePointStyle: true,
      titleFont: { size: 13, weight: 'bold', family: 'Inter, sans-serif' },
      bodyFont: { size: 13, family: 'Inter, sans-serif' },
      cornerRadius: 8
    };

    this.chartOptions = {
        maintainAspectRatio: false,
        aspectRatio: 0.6,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: {
                position: 'top',
                align: 'end',
                labels: {
                    color: textColor,
                    usePointStyle: true,
                    pointStyle: 'rectRounded',
                    boxWidth: 10,
                    boxHeight: 10,
                    padding: 18,
                    font: { weight: '700', family: 'Inter, sans-serif' }
                }
            },
            tooltip: tooltipConfig
        },
        scales: {
            x: {
                ticks: {
                    color: textColorSecondary,
                    maxRotation: 0,
                    autoSkip: true,
                    autoSkipPadding: 18,
                    font: { weight: '600', family: 'Inter, sans-serif' }
                },
                grid: {
                    display: false // Removing vertical grid lines for a cleaner look
                },
                border: { display: true, color: surfaceBorder } // Clean solid baseline to ground the bars
            },
            y: {
                beginAtZero: true,
                suggestedMax: 10, // Defaults the scale to 10 for smaller datasets
                border: { display: false }, // Hide the solid y-axis spine
                ticks: {
                    color: textColorSecondary,
                    precision: 0,
                    font: { weight: '600', family: 'Inter, sans-serif' }
                },
                grid: {
                    color: isDark ? 'rgba(148, 163, 184, 0.18)' : 'rgba(148, 163, 184, 0.22)',
                    drawBorder: false,
                    borderDash: [3, 5]
                }
            }
        }
    };

    this.doughnutChartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '75%', // Slim ring for the advanced HTML layout
      plugins: {
        legend: { display: false },
        tooltip: tooltipConfig
      }
    };

    const currentStats = this.stats();
    if (currentStats) {
      this.categoryChartData = {
        labels: currentStats.categoryStats.map(c => c.name),
        datasets: [{ data: currentStats.categoryStats.map(c => c.count), backgroundColor: currentStats.categoryStats.map(c => c.color), borderWidth: 0 }]
      };

      // Process DB data for the Combo Chart
      const history = currentStats.recentHistory || [];
      const dateMap = new Map<string, { passed: number, failed: number, total: number }>();
      
      // Initialize the last 30 days with 0s to ensure a full timeline
      for (let i = 29; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const label = d.toLocaleString('en-US', { month: 'short', day: 'numeric' });
        dateMap.set(label, { passed: 0, failed: 0, total: 0 });
      }
      
      history.forEach((h: any) => {
          const d = h.date ? new Date(h.date).toLocaleString('en-US', { month: 'short', day: 'numeric' }) : '';
          if (dateMap.has(d)) {
            const entry = dateMap.get(d)!;
            entry.total += Number(h.count);
            if (h.status === 'passed') entry.passed += Number(h.count);
            else if (h.status === 'failed' || h.status === 'error') entry.failed += Number(h.count);
          }
      });

      const labels = Array.from(dateMap.keys());
      const values = Array.from(dateMap.values());
      this.trendSummary = values.reduce<{ total: number; passed: number; failed: number; activeDays: number }>((summary, day) => ({
        passed: summary.passed + day.passed,
        failed: summary.failed + day.failed,
        total: summary.total + day.total,
        activeDays: summary.activeDays + (day.total > 0 ? 1 : 0),
      }), { total: 0, passed: 0, failed: 0, activeDays: 0 });

      this.historyChartData = {
          labels: labels.length ? labels : ['No Data'],
          datasets: [
              {
                  type: 'bar',
                  label: 'Passed Scripts',
                  backgroundColor: 'rgba(16, 185, 129, 0.88)',
                  hoverBackgroundColor: '#10b981',
                  borderColor: '#059669',
                  borderWidth: 0,
                  data: labels.length ? values.map(v => v.passed) : [0],
                  borderRadius: { topLeft: 8, topRight: 8, bottomLeft: 2, bottomRight: 2 },
                  borderSkipped: false,
                  barPercentage: 0.7,
                  categoryPercentage: 0.64,
                  maxBarThickness: 16
              },
              {
                  type: 'bar',
                  label: 'Failed Scripts',
                  backgroundColor: 'rgba(244, 63, 94, 0.86)',
                  hoverBackgroundColor: '#f43f5e',
                  borderColor: '#e11d48',
                  borderWidth: 0,
                  data: labels.length ? values.map(v => v.failed) : [0],
                  borderRadius: { topLeft: 8, topRight: 8, bottomLeft: 2, bottomRight: 2 },
                  borderSkipped: false,
                  barPercentage: 0.7,
                  categoryPercentage: 0.64,
                  maxBarThickness: 16
              }
          ]
      };
    }
  }

  getStatusSeverity(status: string): 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' {
    switch (status) {
      case 'passed': return 'success';
      case 'failed': return 'danger';
      case 'running': return 'warn';
      case 'queued': return 'info';
      case 'stopped': return 'secondary';
      default: return 'secondary';
    }
  }

  getPassRate(): number {
    const s = this.stats();
    if (!s) return 0;
    return clampPercentage(Math.round(Number(s.passRate || 0)));
  }

  formatDate(date: string): string {
    return new Date(date).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  formatDuration(seconds: number | null): string {
    if (seconds === null || seconds === undefined || Number.isNaN(seconds) || seconds < 0) return '-';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  formatEnvironmentLabel(run: ExecutionRun): string {
    return formatExecutionEnvironmentLabel(run.runMetadata?.appUrl, run.environment);
  }
}
