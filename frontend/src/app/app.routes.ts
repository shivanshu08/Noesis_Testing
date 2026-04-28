import { Routes } from '@angular/router';
import { authGuard, guestGuard, adminGuard, editGuard, systemLogsGuard } from './guards/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    canActivate: [guestGuard],
    loadComponent: () => import('./pages/login/login').then(m => m.Login),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./layout/main-layout/main-layout').then(m => m.MainLayout),
    children: [
      { path: 'dashboard', loadComponent: () => import('./pages/dashboard/dashboard').then(m => m.Dashboard) },
      { path: 'scripts', loadComponent: () => import('./pages/scripts/scripts').then(m => m.Scripts) },
      { path: 'scripts/:id/configuration/attachments', loadComponent: () => import('./pages/script-attachments/script-attachments').then(m => m.ScriptAttachments) },
      { path: 'scripts/:id/configuration', loadComponent: () => import('./pages/script-configuration/script-configuration').then(m => m.ScriptConfiguration) },
      { path: 'runner', canActivate: [editGuard], loadComponent: () => import('./pages/runner/runner').then(m => m.Runner) },
      { path: 'suites', loadComponent: () => import('./pages/suites/suites').then(m => m.Suites) },
      { path: 'history', loadComponent: () => import('./pages/history/history').then(m => m.History) },
      { path: 'run/:id', loadComponent: () => import('./pages/run-detail/run-detail').then(m => m.RunDetail) },
      { path: 'users', canActivate: [adminGuard], loadComponent: () => import('./pages/login/users').then(m => m.Users) },
      { path: 'logs', canActivate: [systemLogsGuard], loadComponent: () => import('./pages/logs/logs').then(m => m.LogsPage) },
      { path: 'notifications', loadComponent: () => import('./pages/notifications/notifications').then(m => m.Notifications) },
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
    ],
  },
  { path: '**', redirectTo: 'login' },
];
