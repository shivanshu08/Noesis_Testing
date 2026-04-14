import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';
import { Confirmation } from 'primeng/api';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ToastModule } from 'primeng/toast';

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
  imports: [CommonModule, ConfirmDialogModule, ToastModule],
  template: `
    <ng-container *ngIf="showConfirm">
      <p-confirmDialog #confirmDialog position="top" styleClass="noesis-confirm-dialog">
        <ng-template #icon>
          <i
            class="pi pi-trash noesis-confirm-trash-icon"
            [class.noesis-confirm-trash-icon-delete]="isDeleteConfirmation(confirmDialog.confirmation)"
            aria-hidden="true"
          ></i>
        </ng-template>
      </p-confirmDialog>
    </ng-container>

    <ng-container *ngIf="showToast">
      <p-toast [position]="toastPosition" styleClass="noesis-toast-alert" />
    </ng-container>
  `,
})
export class AlertOverlayComponent {
  @Input() showConfirm = true;
  @Input() showToast = true;
  @Input() toastPosition: ToastPosition = 'bottom-right';

  private readonly deleteHints = ['delete', 'remove', 'clear', 'permanent', 'discard'];

  isDeleteConfirmation(confirmation: Confirmation | null | undefined): boolean {
    const contextText = [
      confirmation?.header || '',
      confirmation?.message || '',
      confirmation?.acceptLabel || '',
      confirmation?.icon || '',
      confirmation?.acceptButtonStyleClass || '',
    ]
      .join(' ')
      .toLowerCase();

    return this.deleteHints.some((hint) => contextText.includes(hint)) || contextText.includes('danger');
  }
}
