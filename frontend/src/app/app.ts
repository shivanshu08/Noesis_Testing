import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { CommonModule } from '@angular/common';
import { SessionService } from './services/session.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, CommonModule],
  template: `
    <!-- Session Timeout Alert Banner -->
    @if (sessionService.showTimeoutAlert()) {
      <div class="session-timeout-overlay">
        <div class="session-timeout-alert" id="session-timeout-alert">
          <div class="session-timeout-icon">
            <i class="pi pi-clock"></i>
          </div>
          <span class="session-timeout-message">The session has been timed out</span>
          <button class="session-timeout-close" (click)="sessionService.dismissAlert()" aria-label="Close">
            <i class="pi pi-times"></i>
          </button>
        </div>
      </div>
    }
    <router-outlet />
  `,
  styles: [],
})
export class App {
  readonly sessionService = inject(SessionService);
}

