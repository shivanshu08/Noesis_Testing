import { Injectable } from '@angular/core';
import { MessageService } from 'primeng/api';

export interface ToastNotification {
  severity: 'success' | 'info' | 'warn' | 'error';
  summary: string;
  detail?: string;
  sticky?: boolean;
  life?: number;
  icon?: string;
}

@Injectable({ providedIn: 'root' })
export class NotificationToastService {
  constructor(private messageService: MessageService) {}

  show(notification: ToastNotification) {
    this.messageService.add({
      severity: notification.severity,
      summary: notification.summary,
      detail: notification.detail || '',
      sticky: notification.sticky || false,
      life: notification.life || 4000,
      icon: notification.icon
    });
  }

  success(summary: string, detail?: string, life: number = 4000) {
    this.show({
      severity: 'success',
      summary,
      detail,
      life,
      icon: 'pi pi-check-circle'
    });
  }

  error(summary: string, detail?: string, sticky: boolean = true) {
    this.show({
      severity: 'error',
      summary,
      detail,
      sticky,
      life: sticky ? undefined : 6000,
      icon: 'pi pi-exclamation-circle'
    });
  }

  warn(summary: string, detail?: string, life: number = 5000) {
    this.show({
      severity: 'warn',
      summary,
      detail,
      life,
      icon: 'pi pi-exclamation-triangle'
    });
  }

  info(summary: string, detail?: string, life: number = 4000) {
    this.show({
      severity: 'info',
      summary,
      detail,
      life,
      icon: 'pi pi-info-circle'
    });
  }

  scriptStarted(scriptName: string) {
    this.info(
      `Script ${scriptName} started`,
      'Execution in progress...',
      3000
    );
  }

  scriptCompleted(scriptName: string, passed: boolean) {
    if (passed) {
      this.success(
        `${scriptName} passed`,
        'All tests completed successfully',
        4000
      );
    } else {
      this.error(
        `${scriptName} failed`,
        'Some tests did not pass',
        false
      );
    }
  }

  executionStarted(count: number) {
    this.info(
      `Executing ${count} script${count > 1 ? 's' : ''}`,
      'Test suite started...',
      3000
    );
  }

  executionCompleted(total: number, passed: number, failed: number) {
    const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;
    if (failed === 0) {
      this.success(
        `All scripts passed`,
        `${total} tests completed - ${passRate}% pass rate`,
        5000
      );
    } else {
      this.warn(
        `Execution completed with failures`,
        `${passed}/${total} passed - ${passRate}% pass rate`,
        6000
      );
    }
  }

  clearAll() {
    this.messageService.clear();
  }
}
