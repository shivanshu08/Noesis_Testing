import { Component, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SessionService } from './services/session.service';
import { AlertOverlayComponent } from './components/alert-overlay/alert-overlay';
import { AuthService } from './services/auth.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, CommonModule, FormsModule, AlertOverlayComponent],
  template: `
    <!-- Session Timeout Re-login Dialog -->
    @if (sessionService.showTimeoutAlert()) {
      <div class="session-timeout-overlay" role="presentation">
        <section
          class="session-timeout-alert"
          id="session-timeout-alert"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="session-timeout-title"
          aria-describedby="session-timeout-description"
          (keydown.escape)="cancelTimedOutSession()"
        >
          <div class="session-timeout-header">
            <div class="session-timeout-icon">
              <i class="pi pi-clock"></i>
            </div>
            <div>
              <h2 id="session-timeout-title">Session Timed Out</h2>
              <p id="session-timeout-description">Login again to continue where you left off.</p>
            </div>
          </div>

          <form class="session-timeout-form" (ngSubmit)="loginAfterTimeout()">
            <label for="session-timeout-username">Username</label>
            <div class="session-timeout-field readonly">
              <i class="pi pi-user"></i>
              <input
                id="session-timeout-username"
                name="sessionTimeoutUsername"
                type="text"
                [value]="sessionService.timedOutUsername()"
                autocomplete="username"
                readonly
              />
            </div>

            <label for="session-timeout-password">Password</label>
            <div class="session-timeout-field" [class.invalid]="timeoutError()">
              <i class="pi pi-lock"></i>
              <input
                id="session-timeout-password"
                name="sessionTimeoutPassword"
                type="password"
                [(ngModel)]="timeoutPassword"
                autocomplete="current-password"
                placeholder="Enter password"
                autofocus
              />
            </div>

            @if (timeoutError()) {
              <div class="session-timeout-error" role="alert">
                <i class="pi pi-exclamation-triangle"></i>
                <span>{{ timeoutError() }}</span>
              </div>
            }

            <div class="session-timeout-actions">
              <button type="button" class="session-timeout-cancel" (click)="cancelTimedOutSession()" [disabled]="timeoutLoading()">
                Cancel
              </button>
              <button type="submit" class="session-timeout-login" [disabled]="timeoutLoading()">
                <span>{{ timeoutLoading() ? 'Logging in...' : 'Login' }}</span>
                <i class="pi pi-sign-in"></i>
              </button>
            </div>
          </form>
        </section>
      </div>
    }
    <app-alert-overlay [showToast]="false" />
    <router-outlet />
  `,
  styles: [],
})
export class App {
  readonly sessionService = inject(SessionService);
  private readonly auth = inject(AuthService);

  timeoutPassword = '';
  readonly timeoutLoading = signal(false);
  readonly timeoutError = signal('');

  loginAfterTimeout(): void {
    const username = this.sessionService.timedOutUsername();
    const password = this.timeoutPassword.trim();

    if (!username || !password) {
      this.timeoutError.set('Please enter your password to continue.');
      return;
    }

    this.timeoutLoading.set(true);
    this.timeoutError.set('');

    this.auth.login({ username, password }).subscribe({
      next: () => {
        this.timeoutLoading.set(false);
        this.timeoutPassword = '';
      },
      error: err => {
        this.timeoutLoading.set(false);
        this.timeoutError.set(err.error?.error || 'Login failed. Please check your password.');
      },
    });
  }

  cancelTimedOutSession(): void {
    this.timeoutPassword = '';
    this.timeoutError.set('');
    this.timeoutLoading.set(false);
    this.auth.cancelTimedOutSession();
  }
}

