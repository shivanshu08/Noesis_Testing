import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, tap, catchError, throwError } from 'rxjs';
import { environment } from '../../environments/environment';
import { User, LoginRequest, LoginResponse } from '../models/interfaces';
import { SessionService } from './session.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly apiUrl = `${environment.apiUrl}/auth`;
  private readonly tokenKey = 'noesis_token';
  private readonly userKey = 'noesis_user';
  private readonly sessionService = inject(SessionService);
  private sessionExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressSessionErrorsUntil = 0;

  private currentUser = signal<User | null>(this.loadValidUser());
  readonly user = this.currentUser.asReadonly();
  readonly isLoggedIn = computed(() => !!this.currentUser());
  readonly isAdmin = computed(() => this.currentUser()?.role === 'admin');
  readonly isViewer = computed(() => this.currentUser()?.role === 'viewer');
  readonly isTester = computed(() => this.currentUser()?.role === 'tester');
  readonly canEdit = computed(() => {
    const role = this.currentUser()?.role;
    return role === 'admin' || role === 'tester';
  });
  readonly canRun = computed(() => this.canEdit());
  readonly assignedScriptCount = computed(() => this.currentUser()?.assignedScriptCount ?? null);

  constructor(private http: HttpClient, private router: Router) {
    this.scheduleSessionExpiry();
  }

  login(credentials: LoginRequest): Observable<LoginResponse> {
    return this.http.post<LoginResponse>(`${this.apiUrl}/login`, credentials).pipe(
      tap(response => {
        localStorage.setItem(this.tokenKey, response.token);
        localStorage.setItem(this.userKey, JSON.stringify(response.user));
        this.currentUser.set(response.user);
        this.sessionService.reset();
        this.scheduleSessionExpiry();
      }),
      catchError(err => throwError(() => err))
    );
  }

  logout(): void {
    this.suppressSessionErrorsUntil = Date.now() + 5000;
    this.clearLocalSession();
    this.sessionService.reset();
    this.router.navigate(['/login']);
  }

  cancelTimedOutSession(): void {
    this.suppressSessionErrorsUntil = Date.now() + 5000;
    this.clearLocalSession();
    this.sessionService.reset();
    this.router.navigate(['/login']);
  }

  private clearLocalSession(): void {
    this.clearSessionExpiryTimer();
    localStorage.removeItem(this.tokenKey);
    localStorage.removeItem(this.userKey);
    this.currentUser.set(null);
  }

  /**
   * Handles session expiration (401 from server).
   * Shows a blocking re-login prompt without redirecting away from the current page.
   */
  sessionExpired(): void {
    // Only proceed if this is a fresh timeout (no duplicate alerts)
    const username = this.currentUser()?.username || this.loadStoredUsername();
    if (!this.sessionService.triggerSessionTimeout(username)) return;

    localStorage.removeItem(this.tokenKey);
    this.clearSessionExpiryTimer();
  }

  handleSessionError(): void {
    if (!this.shouldHandleSessionError()) return;
    this.sessionExpired();
  }

  getToken(): string | null {
    const token = localStorage.getItem(this.tokenKey);
    if (!token) return null;
    if (this.isTokenExpired(token)) {
      this.sessionExpired();
      return null;
    }
    return token;
  }

  changePassword(currentPassword: string, newPassword: string): Observable<any> {
    return this.http.put(`${this.apiUrl}/change-password`, { currentPassword, newPassword });
  }

  forgotPassword(email: string): Observable<any> {
    return this.http.post(`${this.apiUrl}/forgot-password`, { email });
  }

  fetchProfile(): Observable<User> {
    return this.http.get<User>(`${this.apiUrl}/me`).pipe(
      tap(user => {
        this.currentUser.set(user);
        localStorage.setItem(this.userKey, JSON.stringify(user));
      })
    );
  }

  private loadValidUser(): User | null {
    const token = localStorage.getItem(this.tokenKey);
    if (!token || this.isTokenExpired(token)) {
      localStorage.removeItem(this.tokenKey);
      localStorage.removeItem(this.userKey);
      return null;
    }
    const stored = localStorage.getItem(this.userKey);
    if (stored) {
      try { return JSON.parse(stored); } catch { return null; }
    }
    return null;
  }

  private loadStoredUsername(): string {
    const stored = localStorage.getItem(this.userKey);
    if (!stored) return '';
    try {
      const user = JSON.parse(stored) as Partial<User>;
      return typeof user.username === 'string' ? user.username : '';
    } catch {
      return '';
    }
  }

  private scheduleSessionExpiry(): void {
    this.clearSessionExpiryTimer();
    const token = localStorage.getItem(this.tokenKey);
    const expiresAt = token ? this.getTokenExpiryMs(token) : null;
    if (!expiresAt) return;

    const delay = expiresAt - Date.now();
    if (delay <= 0) {
      this.sessionExpired();
      return;
    }
    this.sessionExpiryTimer = setTimeout(() => this.sessionExpired(), delay);
  }

  private clearSessionExpiryTimer(): void {
    if (this.sessionExpiryTimer) {
      clearTimeout(this.sessionExpiryTimer);
      this.sessionExpiryTimer = null;
    }
  }

  private shouldHandleSessionError(): boolean {
    if (Date.now() < this.suppressSessionErrorsUntil) return false;
    return !!localStorage.getItem(this.tokenKey) || !!this.currentUser();
  }

  private isTokenExpired(token: string): boolean {
    const expiresAt = this.getTokenExpiryMs(token);
    return !expiresAt || expiresAt <= Date.now();
  }

  private getTokenExpiryMs(token: string): number | null {
    try {
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      const exp = Number(payload.exp);
      return Number.isFinite(exp) ? exp * 1000 : null;
    } catch {
      return null;
    }
  }
}
