import { Injectable, signal } from '@angular/core';

/**
 * Centralized session management service.
 * Handles session timeout detection, re-login dialog state, and
 * prevents duplicate session-expired alerts from flooding the UI.
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
  /** Whether the session timeout alert banner/dialog is currently visible */
  readonly showTimeoutAlert = signal(false);
  readonly timedOutUsername = signal('');
  readonly timedOutAt = signal<Date | null>(null);

  /** Prevents duplicate triggers while a timeout is already being handled */
  private _handling = false;

  /**
   * Triggers the session timeout flow:
   * - Shows the re-login dialog
   * - Keeps the last username available for the prompt
   * - Returns a boolean indicating if this was a fresh trigger (not duplicate)
   */
  triggerSessionTimeout(username = ''): boolean {
    if (this._handling) return false; // Prevent duplicate alerts
    this._handling = true;
    this.timedOutUsername.set(username);
    this.timedOutAt.set(new Date());
    this.showTimeoutAlert.set(true);

    return true;
  }

  /** Dismiss the alert/dialog after the user has re-authenticated or cancelled */
  dismissAlert(): void {
    this.showTimeoutAlert.set(false);
    this._handling = false;
    this.timedOutUsername.set('');
    this.timedOutAt.set(null);
  }

  reset(): void {
    this.showTimeoutAlert.set(false);
    this._handling = false;
  }
}
