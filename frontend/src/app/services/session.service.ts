import { Injectable, signal } from '@angular/core';

/**
 * Centralized session management service.
 * Handles session timeout detection, alert display, and
 * prevents duplicate session-expired alerts from flooding the UI.
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
  /** Whether the session timeout alert banner is currently visible */
  readonly showTimeoutAlert = signal(false);

  /** Prevents duplicate triggers while a timeout is already being handled */
  private _handling = false;

  /**
   * Triggers the session timeout flow:
   * - Shows the top-center alert banner
   * - Auto-hides after 5 seconds
   * - Returns a boolean indicating if this was a fresh trigger (not duplicate)
   */
  triggerSessionTimeout(): boolean {
    if (this._handling) return false; // Prevent duplicate alerts
    this._handling = true;
    this.showTimeoutAlert.set(true);

    // Auto-dismiss the alert after 5 seconds
    setTimeout(() => {
      this.dismissAlert();
    }, 5000);

    return true;
  }

  /** Dismiss the alert banner manually (e.g. close button click) */
  dismissAlert(): void {
    this.showTimeoutAlert.set(false);
    this._handling = false;
  }

  reset(): void {
    this.showTimeoutAlert.set(false);
    this._handling = false;
  }
}
