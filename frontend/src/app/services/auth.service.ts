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

  private currentUser = signal<User | null>(this.loadUser());
  readonly user = this.currentUser.asReadonly();
  readonly isLoggedIn = computed(() => !!this.currentUser());
  readonly isAdmin = computed(() => this.currentUser()?.role === 'admin');
  readonly isViewer = computed(() => this.currentUser()?.role === 'viewer');
  readonly canEdit = computed(() => {
    const role = this.currentUser()?.role;
    return role === 'admin' || role === 'tester';
  });
  readonly isTester = computed(() => this.currentUser()?.role === 'tester');
  readonly assignedScriptCount = computed(() => this.currentUser()?.assignedScriptCount ?? null);

  constructor(private http: HttpClient, private router: Router) {}

  login(credentials: LoginRequest): Observable<LoginResponse> {
    return this.http.post<LoginResponse>(`${this.apiUrl}/login`, credentials).pipe(
      tap(response => {
        localStorage.setItem(this.tokenKey, response.token);
        localStorage.setItem(this.userKey, JSON.stringify(response.user));
        this.currentUser.set(response.user);
      }),
      catchError(err => throwError(() => err))
    );
  }

  logout(): void {
    localStorage.removeItem(this.tokenKey);
    localStorage.removeItem(this.userKey);
    this.currentUser.set(null);
    this.router.navigate(['/login']);
  }

  /**
   * Handles session expiration (401 from server).
   * Shows a top-center alert, clears credentials, and redirects to login.
   */
  sessionExpired(): void {
    // Only proceed if this is a fresh timeout (no duplicate alerts)
    if (!this.sessionService.triggerSessionTimeout()) return;

    localStorage.removeItem(this.tokenKey);
    localStorage.removeItem(this.userKey);
    this.currentUser.set(null);
    this.router.navigate(['/login']);
  }

  getToken(): string | null {
    return localStorage.getItem(this.tokenKey);
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

  private loadUser(): User | null {
    const stored = localStorage.getItem(this.userKey);
    if (stored) {
      try { return JSON.parse(stored); } catch { return null; }
    }
    return null;
  }
}
