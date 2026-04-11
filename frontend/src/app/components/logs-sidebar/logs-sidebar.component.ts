import { Component, OnInit, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { LogService, AppLog } from '../../services/log.service';

@Component({
  selector: 'app-logs-sidebar',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
  ],
  template: `
    <div class="logs-sidebar-container">
      <!-- Sidebar Toggle Button -->
      <button 
        class="logs-toggle-btn"
        (click)="visible = !visible"
        title="Execution Logs"
      >
        <i class="pi pi-list"></i>
        @if (unreadCount() > 0) {
          <span class="badge-count">{{ unreadCount() }}</span>
        }
      </button>

      <!-- Sidebar Panel -->
      <div 
        class="logs-sidebar-panel"
        [class.visible]="visible"
      >
        <div class="sidebar-header">
            <div class="header-title">
              <i class="pi pi-list"></i>
              <span>Execution Logs</span>
            </div>
            <button class="close-btn" (click)="visible = false">
              <i class="pi pi-times"></i>
            </button>
          </div>

        <!-- Date Filters -->
        <div class="logs-filters">
          <div class="filter-group">
            <label>From Date</label>
            <input 
              type="date" 
              class="filter-input"
              [(ngModel)]="dateFrom"
              (change)="applyDateFilter()"
            />
          </div>
          <div class="filter-group">
            <label>To Date</label>
            <input 
              type="date" 
              class="filter-input"
              [(ngModel)]="dateTo"
              (change)="applyDateFilter()"
            />
          </div>
          <button class="filter-clear-btn" (click)="clearDateFilter()">
            <i class="pi pi-times"></i> Clear
          </button>
        </div>

        <!-- Export Buttons -->
        <div class="export-buttons">
          <button 
            class="export-btn csv-btn"
            (click)="exportCSV()"
            [disabled]="displayedLogs().length === 0"
            title="Export to CSV"
          >
            <i class="pi pi-download"></i> CSV
          </button>
          <button 
            class="export-btn pdf-btn"
            (click)="exportPDF()"
            [disabled]="displayedLogs().length === 0"
            title="Export to PDF"
          >
            <i class="pi pi-file-pdf"></i> PDF
          </button>
        </div>

        <!-- Logs List -->
        <div class="logs-list">
          @if (logService.loading()) {
            <div class="loading">
              <i class="pi pi-spin pi-spinner"></i>
              <p>Loading logs...</p>
            </div>
          } @else if (displayedLogs().length === 0) {
            <div class="empty-state">
              <i class="pi pi-inbox"></i>
              <p>No logs found</p>
            </div>
          } @else {
            @for (log of displayedLogs(); track log.id) {
              <div class="log-item" [class]="'severity-' + log.severity">
                <div class="log-icon">
                  <i [class]="logService.getSeverityIcon(log.severity)"></i>
                </div>
                <div class="log-content">
                  <div class="log-summary">{{ log.summary }}</div>
                  <div class="log-detail">{{ log.detail }}</div>
                  <div class="log-meta">
                    <span class="log-time">{{ formatTime(log.timestamp) }}</span>
                    <span class="log-source">{{ log.source }}</span>
                  </div>
                </div>
              </div>
            }
          }
        </div>
      </div>
      
      <!-- Sidebar Overlay -->
      @if (visible) {
        <div class="sidebar-overlay" (click)="visible = false"></div>
      }
    </div>
  `,
  styles: [`
    .logs-sidebar-container {
      position: relative;
    }

    .sidebar-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 998;
      animation: fadeIn 0.2s ease-in-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .logs-sidebar-panel {
      position: fixed;
      top: 0;
      right: -420px;
      width: 420px;
      height: 100vh;
      background: white;
      box-shadow: -2px 0 8px rgba(0, 0, 0, 0.15);
      z-index: 1000;
      transition: right 0.3s ease-in-out;
      display: flex;
      flex-direction: column;
      max-width: 100vw;

      &.visible {
        right: 0;
      }
    }

    .logs-toggle-btn {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      border: none;
      color: white;
      font-size: 1.25rem;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 999;
      position: relative;

      &:hover {
        transform: scale(1.1);
        box-shadow: 0 8px 20px rgba(99, 102, 241, 0.6);
      }

      &:active {
        transform: scale(0.95);
      }

      .badge-count {
        position: absolute;
        top: -4px;
        right: -4px;
        background: #ef4444;
        color: white;
        font-size: 0.7rem;
        min-width: 20px;
        height: 20px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: bold;
        border: 2px solid white;
        padding: 0 4px;
      }
    }

    .sidebar-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px;
      border-bottom: 1px solid #e5e7eb;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      color: white;
      flex-shrink: 0;

      .header-title {
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 1.1rem;
        font-weight: 600;

        i {
          font-size: 1.25rem;
        }
      }

      .close-btn {
        background: rgba(255, 255, 255, 0.2);
        border: none;
        color: white;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1rem;
        transition: background 0.2s;

        &:hover {
          background: rgba(255, 255, 255, 0.3);
        }
      }
    }

    .logs-filters {
      padding: 16px;
      border-bottom: 1px solid #e5e7eb;
      background: #f9fafb;
      display: flex;
      flex-direction: column;
      gap: 12px;
      flex-shrink: 0;

      .filter-group {
        display: flex;
        flex-direction: column;
        gap: 6px;

        label {
          font-size: 0.8rem;
          font-weight: 600;
          color: #6b7280;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .filter-input {
          padding: 8px 12px;
          border: 1px solid #d1d5db;
          border-radius: 6px;
          font-size: 0.9rem;
          transition: all 0.2s;

          &:focus {
            outline: none;
            border-color: #6366f1;
            box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.1);
          }
        }
      }

      .filter-clear-btn {
        align-self: flex-end;
        padding: 6px 12px;
        font-size: 0.8rem;
        background: transparent;
        border: 1px solid #d1d5db;
        border-radius: 4px;
        color: #6b7280;
        cursor: pointer;
        transition: all 0.2s;
        display: flex;
        align-items: center;
        gap: 4px;

        &:hover {
          background: #f3f4f6;
          border-color: #9ca3af;
        }

        i {
          font-size: 0.75rem;
        }
      }
    }

    .export-buttons {
      padding: 12px 16px;
      display: flex;
      gap: 8px;
      border-bottom: 1px solid #e5e7eb;
      background: #f9fafb;
      flex-shrink: 0;

      .export-btn {
        flex: 1;
        padding: 8px 12px;
        font-size: 0.85rem;
        border: 1px solid;
        border-radius: 6px;
        cursor: pointer;
        transition: all 0.2s;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        font-weight: 500;

        i {
          font-size: 0.9rem;
        }

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        &:not(:disabled):hover {
          transform: translateY(-1px);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }
      }

      .csv-btn {
        background: #dbeafe;
        color: #1e40af;
        border-color: #93c5fd;

        &:not(:disabled):hover {
          background: #bfdbfe;
        }
      }

      .pdf-btn {
        background: #fee2e2;
        color: #991b1b;
        border-color: #fecaca;

        &:not(:disabled):hover {
          background: #fecaca;
        }
      }
    }

    .logs-list {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 8px;
      background: white;

      .loading, .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 60px 20px;
        text-align: center;
        color: #9ca3af;

        i {
          font-size: 2.5rem;
          margin-bottom: 12px;
          opacity: 0.4;
        }

        p {
          margin: 0;
          font-size: 0.9rem;
        }
      }

      .log-item {
        display: flex;
        gap: 12px;
        padding: 12px;
        margin: 4px;
        border-radius: 8px;
        background: white;
        border-left: 4px solid #d1d5db;
        transition: all 0.2s;
        cursor: pointer;

        &:hover {
          background: #f9fafb;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
        }

        &.severity-success {
          border-left-color: #10b981;
          background: rgba(16, 185, 129, 0.05);
        }

        &.severity-error {
          border-left-color: #ef4444;
          background: rgba(239, 68, 68, 0.05);
        }

        &.severity-warn {
          border-left-color: #f59e0b;
          background: rgba(245, 158, 11, 0.05);
        }

        &.severity-info {
          border-left-color: #3b82f6;
          background: rgba(59, 130, 246, 0.05);
        }

        .log-icon {
          min-width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          font-size: 0.9rem;

          i {
            font-size: 1rem;
          }
        }

        .severity-success .log-icon {
          background: rgba(16, 185, 129, 0.15);
          color: #10b981;
        }

        .severity-error .log-icon {
          background: rgba(239, 68, 68, 0.15);
          color: #ef4444;
        }

        .severity-warn .log-icon {
          background: rgba(245, 158, 11, 0.15);
          color: #f59e0b;
        }

        .severity-info .log-icon {
          background: rgba(59, 130, 246, 0.15);
          color: #3b82f6;
        }

        .log-content {
          flex: 1;
          min-width: 0;

          .log-summary {
            font-weight: 600;
            color: #1f2937;
            font-size: 0.9rem;
            margin-bottom: 4px;
          }

          .log-detail {
            color: #6b7280;
            font-size: 0.8rem;
            margin-bottom: 6px;
            overflow: hidden;
            text-overflow: ellipsis;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
          }

          .log-meta {
            display: flex;
            gap: 12px;
            font-size: 0.7rem;
            color: #9ca3af;

            .log-time {
              font-family: 'Courier New', monospace;
            }

            .log-source {
              background: #f3f4f6;
              padding: 2px 8px;
              border-radius: 4px;
            }
          }
        }
      }
    }
  `]
})
export class LogsSidebarComponent implements OnInit {
  visible = false;
  dateFrom: string | null = null;
  dateTo: string | null = null;
  displayedLogs = signal<AppLog[]>([]);
  unreadCount = signal(0);

  constructor(public logService: LogService) {
    // Update displayed logs whenever logService.logs changes
    effect(() => {
      this.displayedLogs.set(this.logService.logs());
      this.updateUnreadCount();
    });
  }

  ngOnInit() {
    this.logService.load();
  }

  private updateUnreadCount() {
    // Count logs from today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayLogs = this.logService.logs().filter(l => {
      const logDate = new Date(l.timestamp);
      logDate.setHours(0, 0, 0, 0);
      return logDate.getTime() === today.getTime();
    });
    this.unreadCount.set(todayLogs.length);
  }

  applyDateFilter() {
    if (this.dateFrom && this.dateTo) {
      const from = new Date(this.dateFrom);
      const to = new Date(this.dateTo);
      to.setHours(23, 59, 59, 999);
      const filtered = this.logService.getLogsByDateRange(from, to);
      this.displayedLogs.set(filtered);
    } else {
      this.displayedLogs.set(this.logService.logs());
    }
  }

  clearDateFilter() {
    this.dateFrom = null;
    this.dateTo = null;
    this.displayedLogs.set(this.logService.logs());
  }

  formatTime(date: Date): string {
    return new Date(date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  exportCSV() {
    this.logService.exportToCSV(this.displayedLogs());
  }

  exportPDF() {
    this.logService.exportToPDF(this.displayedLogs());
  }
}
