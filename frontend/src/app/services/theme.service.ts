import { Injectable, signal } from '@angular/core';

export interface AppTheme {
  name: string;
  label: string;
  primary: string;
  primaryDark: string;
  accent: string;
  sidebarBg: string;
  sidebarActive: string;
}

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly themes: AppTheme[] = [
    { name: 'indigo', label: 'Indigo', primary: '#6366f1', primaryDark: '#4f46e5', accent: '#a78bfa', sidebarBg: '#1e1e2e', sidebarActive: 'rgba(99, 102, 241, 0.15)' },
    { name: 'ocean', label: 'Ocean Blue', primary: '#0ea5e9', primaryDark: '#0284c7', accent: '#38bdf8', sidebarBg: '#0f172a', sidebarActive: 'rgba(14, 165, 233, 0.15)' },
    { name: 'emerald', label: 'Emerald', primary: '#10b981', primaryDark: '#059669', accent: '#34d399', sidebarBg: '#0f1a14', sidebarActive: 'rgba(16, 185, 129, 0.15)' },
    { name: 'rose', label: 'Rose', primary: '#f43f5e', primaryDark: '#e11d48', accent: '#fb7185', sidebarBg: '#1a0f14', sidebarActive: 'rgba(244, 63, 94, 0.15)' },
    { name: 'amber', label: 'Amber', primary: '#f59e0b', primaryDark: '#d97706', accent: '#fbbf24', sidebarBg: '#1a1408', sidebarActive: 'rgba(245, 158, 11, 0.15)' },
    { name: 'teal', label: 'Teal', primary: '#14b8a6', primaryDark: '#0d9488', accent: '#2dd4bf', sidebarBg: '#0f1a19', sidebarActive: 'rgba(20, 184, 166, 0.15)' },
  ];

  private currentTheme = signal<AppTheme>(this.loadTheme());
  readonly theme = this.currentTheme.asReadonly();

  constructor() {
    this.applyTheme(this.currentTheme());
  }

  setTheme(theme: AppTheme): void {
    this.currentTheme.set(theme);
    localStorage.setItem('noesis_theme', theme.name);
    this.applyTheme(theme);
  }

  private loadTheme(): AppTheme {
    const saved = localStorage.getItem('noesis_theme');
    return this.themes.find(t => t.name === saved) || this.themes[0];
  }

  private applyTheme(theme: AppTheme): void {
    const root = document.documentElement;
    root.style.setProperty('--noesis-primary', theme.primary);
    root.style.setProperty('--noesis-primary-dark', theme.primaryDark);
    root.style.setProperty('--noesis-accent', theme.accent);
    root.style.setProperty('--noesis-sidebar-bg', theme.sidebarBg);
    root.style.setProperty('--noesis-sidebar-active', theme.sidebarActive);
  }
}
