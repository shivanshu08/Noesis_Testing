import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { AuthService } from '../services/auth.service';
import { catchError, throwError } from 'rxjs';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const token = authService.getToken();

  // Don't attach token or intercept 401 on login requests
  const isLoginRequest = req.url.includes('/auth/login');

  if (token && !isLoginRequest) {
    req = req.clone({
      setHeaders: {
        Authorization: `Bearer ${token}`,
      },
    });
  }

  return next(req).pipe(
    catchError(error => {
      // Trigger session timeout alert on 401 (expired/invalid token)
      // Skip for login requests — those have their own error handling
      if (error.status === 401 && !isLoginRequest) {
        authService.sessionExpired();
      }
      return throwError(() => error);
    })
  );
};

