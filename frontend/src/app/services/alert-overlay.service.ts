import { Injectable, signal } from '@angular/core';

export type AlertSeverity = 'info' | 'success' | 'warn' | 'danger';
export type AlertButtonSeverity = 'secondary' | 'success' | 'info' | 'warn' | 'danger' | 'help' | 'contrast';

export interface AlertButton<T = unknown> {
  label: string;
  value: T;
  icon?: string;
  severity?: AlertButtonSeverity;
  outlined?: boolean;
  text?: boolean;
  autofocus?: boolean;
}

export interface AlertRequest<T = unknown> {
  title?: string;
  message: string;
  detail?: string;
  icon?: string;
  severity?: AlertSeverity;
  buttons?: AlertButton<T>[];
  closeOnEscape?: boolean;
}

interface ActiveAlert extends Required<Pick<AlertRequest, 'closeOnEscape'>> {
  title: string;
  message: string;
  detail?: string;
  icon: string;
  severity: AlertSeverity;
  buttons: AlertButton[];
  resolve: (value: unknown) => void;
}

@Injectable({ providedIn: 'root' })
export class AlertOverlayService {
  readonly current = signal<ActiveAlert | null>(null);

  alert(options: Omit<AlertRequest<'ok'>, 'buttons'> | string): Promise<void> {
    const request = typeof options === 'string' ? { message: options } : options;

    return this.open<'ok'>({
      title: request.title ?? 'Alert',
      message: request.message,
      detail: request.detail,
      icon: request.icon,
      severity: request.severity ?? 'info',
      closeOnEscape: request.closeOnEscape,
      buttons: [
        { label: 'OK', value: 'ok', icon: 'pi pi-check', autofocus: true },
      ],
    }).then(() => undefined);
  }

  confirm(options: Omit<AlertRequest<boolean>, 'buttons'> & {
    acceptLabel?: string;
    rejectLabel?: string;
    acceptIcon?: string;
    rejectIcon?: string;
    danger?: boolean;
  }): Promise<boolean> {
    return this.open<boolean>({
      title: options.title ?? 'Confirm',
      message: options.message,
      detail: options.detail,
      icon: options.icon,
      severity: options.severity ?? (options.danger ? 'danger' : 'warn'),
      closeOnEscape: options.closeOnEscape,
      buttons: [
        {
          label: options.rejectLabel ?? 'Cancel',
          value: false,
          icon: options.rejectIcon ?? 'pi pi-times',
          severity: 'secondary',
          text: true,
          autofocus: true,
        },
        {
          label: options.acceptLabel ?? 'OK',
          value: true,
          icon: options.acceptIcon ?? 'pi pi-check',
          severity: options.danger ? 'danger' : undefined,
        },
      ],
    }).then((value) => value === true);
  }

  choose<T = string>(options: AlertRequest<T>): Promise<T | undefined> {
    return this.open(options);
  }

  close(value?: unknown): void {
    const active = this.current();
    if (!active) return;

    this.current.set(null);
    active.resolve(value as never);
  }

  private open<T>(options: AlertRequest<T>): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve) => {
      this.current.set({
        title: options.title ?? 'Alert',
        message: options.message,
        detail: options.detail,
        icon: options.icon ?? this.getIcon(options.severity ?? 'info'),
        severity: options.severity ?? 'info',
        buttons: options.buttons?.length
          ? options.buttons
          : [{ label: 'OK', value: 'ok' as T, icon: 'pi pi-check', autofocus: true }],
        closeOnEscape: options.closeOnEscape ?? true,
        resolve: resolve as (value: unknown) => void,
      });
    });
  }

  private getIcon(severity: AlertSeverity): string {
    switch (severity) {
      case 'success': return 'pi pi-check-circle';
      case 'warn': return 'pi pi-exclamation-triangle';
      case 'danger': return 'pi pi-trash';
      default: return 'pi pi-info-circle';
    }
  }
}
