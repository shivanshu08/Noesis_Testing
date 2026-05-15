import { CommonModule } from '@angular/common';
import { Component, Input, inject } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { AlertButton, AlertOverlayService } from '../../services/alert-overlay.service';

type ToastPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

@Component({
  selector: 'app-alert-overlay',
  standalone: true,
  imports: [CommonModule, ButtonModule, DialogModule, ToastModule],
  template: `
    <ng-container *ngIf="showConfirm">
      @if (alertService.current(); as alert) {
        <p-dialog
          [visible]="true"
          [modal]="true"
          [draggable]="false"
          [resizable]="false"
          [closable]="true"
          [closeOnEscape]="alert.closeOnEscape"
          [header]="alert.title"
          position="top"
          [style]="{ width: 'min(430px, 92vw)' }"
          styleClass="noesis-alert-dialog"
          appendTo="body"
          (onHide)="alertService.close()"
        >
          <div class="noesis-alert-content" [ngClass]="'severity-' + alert.severity">
            <span class="noesis-alert-icon">
              <i [class]="alert.icon" aria-hidden="true"></i>
            </span>
            <div class="noesis-alert-copy">
              <p>{{ alert.message }}</p>
              @if (alert.detail) {
                <small>{{ alert.detail }}</small>
              }
            </div>
          </div>

          <ng-template pTemplate="footer">
            <div class="noesis-alert-actions">
              @for (button of alert.buttons; track button.value) {
                <p-button
                  [label]="button.label"
                  [icon]="button.icon"
                  [severity]="button.severity"
                  [outlined]="button.outlined"
                  [text]="button.text"
                  [autofocus]="button.autofocus"
                  size="small"
                  (onClick)="selectButton(button)"
                />
              }
            </div>
          </ng-template>
        </p-dialog>
      }
    </ng-container>

    <ng-container *ngIf="showToast">
      <p-toast [position]="toastPosition" styleClass="noesis-toast-alert" />
    </ng-container>
  `,
})
export class AlertOverlayComponent {
  protected readonly alertService = inject(AlertOverlayService);

  @Input() showConfirm = true;
  @Input() showToast = true;
  @Input() toastPosition: ToastPosition = 'bottom-right';

  selectButton(button: AlertButton): void {
    this.alertService.close(button.value);
  }
}
