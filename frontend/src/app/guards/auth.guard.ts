import { inject } from '@angular/core';
import { ActivatedRouteSnapshot, CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

export const authGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.isLoggedIn()) {
    return true;
  }

  return router.createUrlTree(['/']);
};

export const guestGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (!authService.isLoggedIn()) {
    return true;
  }

  return router.createUrlTree(['/dashboard']);
};

export const adminGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.isAdmin()) return true;

  return router.createUrlTree(['/dashboard']);
};

export const editGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.canEdit()) return true;

  return router.createUrlTree(['/dashboard']);
};

export const platformGuard: CanActivateFn = (route: ActivatedRouteSnapshot) => {
  const authService = inject(AuthService);
  const router = inject(Router);
  const platform = route.paramMap.get('platform');
  const access = authService.user()?.platformAccess || ['test-automation'];
  return platform && access.includes(platform as any) ? true : router.createUrlTree(['/']);
};