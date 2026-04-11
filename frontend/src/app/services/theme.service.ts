import { Injectable, signal } from '@angular/core';

export interface AppTheme {
  name: string;
  label: string;
  primary: string;
  primaryDark: string;
  accent: string;
  sidebarBgLight: string;
  sidebarBgDark: string;
  sidebarActiveLight: string;
  sidebarActiveDark: string;
}

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly themes: AppTheme[] = [
    { name: 'indigo', label: 'Indigo', primary: '#6366f1', primaryDark: '#4f46e5', accent: '#a78bfa', sidebarBgLight: '#f8fafc', sidebarBgDark: '#1e1e2e', sidebarActiveLight: '#e2e8f0', sidebarActiveDark: 'rgba(99, 102, 241, 0.15)' },
    { name: 'ocean', label: 'Ocean Blue', primary: '#0ea5e9', primaryDark: '#0284c7', accent: '#38bdf8', sidebarBgLight: '#f0f9ff', sidebarBgDark: '#0f172a', sidebarActiveLight: '#e0f2fe', sidebarActiveDark: 'rgba(14, 165, 233, 0.15)' },
    { name: 'emerald', label: 'Emerald', primary: '#10b981', primaryDark: '#059669', accent: '#34d399', sidebarBgLight: '#ecfdf5', sidebarBgDark: '#0f1a14', sidebarActiveLight: '#d1fae5', sidebarActiveDark: 'rgba(16, 185, 129, 0.15)' },
    { name: 'rose', label: 'Rose', primary: '#f43f5e', primaryDark: '#e11d48', accent: '#fb7185', sidebarBgLight: '#fff1f2', sidebarBgDark: '#1a0f14', sidebarActiveLight: '#ffe4e6', sidebarActiveDark: 'rgba(244, 63, 94, 0.15)' },
    { name: 'amber', label: 'Amber', primary: '#f59e0b', primaryDark: '#d97706', accent: '#fbbf24', sidebarBgLight: '#fffbeb', sidebarBgDark: '#1a1408', sidebarActiveLight: '#fef3c7', sidebarActiveDark: 'rgba(245, 158, 11, 0.15)' },
    { name: 'teal', label: 'Teal', primary: '#14b8a6', primaryDark: '#0d9488', accent: '#2dd4bf', sidebarBgLight: '#f0fdfa', sidebarBgDark: '#0f1a19', sidebarActiveLight: '#ccfbf1', sidebarActiveDark: 'rgba(20, 184, 166, 0.15)' },
    { name: 'sunset', label: 'Sunset', primary: '#f97316', primaryDark: '#ea580c', accent: '#f43f5e', sidebarBgLight: '#fff7ed', sidebarBgDark: '#1a0f0a', sidebarActiveLight: '#ffedd5', sidebarActiveDark: 'rgba(249, 115, 22, 0.15)' },
    { name: 'cyberpunk', label: 'Cyberpunk', primary: '#d946ef', primaryDark: '#be185d', accent: '#06b6d4', sidebarBgLight: '#fdf4ff', sidebarBgDark: '#12031a', sidebarActiveLight: '#fae8ff', sidebarActiveDark: 'rgba(217, 70, 239, 0.15)' },
    { name: 'midnight', label: 'Midnight', primary: '#8b5cf6', primaryDark: '#7c3aed', accent: '#3b82f6', sidebarBgLight: '#f5f3ff', sidebarBgDark: '#0b0f19', sidebarActiveLight: '#ede9fe', sidebarActiveDark: 'rgba(139, 92, 246, 0.15)' },
    { name: 'slate', label: 'Slate', primary: '#64748b', primaryDark: '#475569', accent: '#94a3b8', sidebarBgLight: '#f8fafc', sidebarBgDark: '#0f1115', sidebarActiveLight: '#f1f5f9', sidebarActiveDark: 'rgba(100, 116, 139, 0.15)' },
  ];

  private currentTheme = signal<AppTheme>(this.loadTheme());
  readonly theme = this.currentTheme.asReadonly();

  private darkMode = signal<boolean>(this.loadDarkMode());
  readonly isDarkMode = this.darkMode.asReadonly();

  constructor() {
    this.applyDarkMode(this.darkMode());
    this.applyTheme(this.currentTheme());
  }

  setTheme(theme: AppTheme): void {
    this.currentTheme.set(theme);
    localStorage.setItem('noesis_theme', theme.name);
    this.applyTheme(theme);
  }

  toggleDarkMode(): void {
    const newMode = !this.darkMode();
    this.darkMode.set(newMode);
    localStorage.setItem('noesis_dark_mode', newMode ? 'true' : 'false');
    this.applyDarkMode(newMode);
  }

  private loadTheme(): AppTheme {
    const saved = localStorage.getItem('noesis_theme');
    return this.themes.find(t => t.name === saved) || this.themes[0];
  }

  private loadDarkMode(): boolean {
    const saved = localStorage.getItem('noesis_dark_mode');
    if (saved !== null) {
      return saved === 'true';
    }
    // Default to dark theme across the application
    return true;
  }

  private applyTheme(theme: AppTheme): void {
    const root = document.documentElement;
    const isDark = this.darkMode();

    root.style.setProperty('--noesis-primary', theme.primary);
    root.style.setProperty('--noesis-primary-dark', theme.primaryDark);
    root.style.setProperty('--noesis-accent', theme.accent);
    root.style.setProperty('--noesis-sidebar-bg', isDark ? theme.sidebarBgDark : theme.sidebarBgLight);
    root.style.setProperty('--noesis-sidebar-active', isDark ? theme.sidebarActiveDark : theme.sidebarActiveLight);
    
    // Map custom theme to PrimeNG v18 Aura native variables so ALL buttons/bars sync flawlessly
    root.style.setProperty('--primary-color', theme.primary);
    root.style.setProperty('--p-primary-color', theme.primary);
    root.style.setProperty('--p-primary-500', theme.primary);
    root.style.setProperty('--p-primary-600', theme.primaryDark);
    root.style.setProperty('--p-primary-400', theme.accent);
  }

  private applyDarkMode(isDark: boolean): void {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add('dark-mode');
      root.classList.add('p-dark'); // <-- CRITICAL: Triggers PrimeNG's native dark mode on all inputs/cards
      root.style.setProperty('--logo-filter', 'brightness(0) invert(1)');
      
      // Update global Noesis variables for dark mode
      root.style.setProperty('--noesis-bg', '#0f172a');
      root.style.setProperty('--noesis-surface', '#1e293b');
      root.style.setProperty('--noesis-text', '#f8fafc');
      root.style.setProperty('--noesis-text-secondary', '#94a3b8');
      root.style.setProperty('--noesis-border', '#334155');
      
      // Remove custom overrides so PrimeNG uses its PERFECT native Dark Aura palette
      for (let i = 0; i <= 950; i += (i === 0 ? 50 : (i === 50 ? 50 : 100))) {
        root.style.removeProperty(`--p-surface-${i}`);
      }
      root.style.removeProperty('--p-content-background');
      root.style.removeProperty('--p-content-hover-background');
      root.style.removeProperty('--p-content-border-color');

      // Map Layout Variables to the Palette
      root.style.setProperty('--surface-ground', 'var(--p-surface-950)');
      root.style.setProperty('--surface-section', 'var(--p-surface-900)');
      root.style.setProperty('--surface-card', 'var(--p-surface-900)');
      root.style.setProperty('--surface-overlay', 'var(--p-surface-800)');
      root.style.setProperty('--surface-border', 'var(--p-surface-700)');
      root.style.setProperty('--surface-hover', 'var(--p-surface-800)');
      root.style.setProperty('--text-color', 'var(--p-surface-0)');
      root.style.setProperty('--text-color-secondary', 'var(--p-surface-400)');
    } else {
      root.classList.remove('dark-mode');
      root.classList.remove('p-dark');
      root.style.setProperty('--logo-filter', 'brightness(0)');
      
      // Update global Noesis variables for light mode
      root.style.setProperty('--noesis-bg', '#f8f9fc');
      root.style.setProperty('--noesis-surface', '#ffffff');
      root.style.setProperty('--noesis-text', '#1e293b');
      root.style.setProperty('--noesis-text-secondary', '#64748b');
      root.style.setProperty('--noesis-border', '#e2e8f0');
      
      // Strip the custom palette so PrimeNG uses its default beautiful Light mode
      for (let i = 0; i <= 950; i += (i === 0 ? 50 : (i === 50 ? 50 : 100))) {
        root.style.removeProperty(`--p-surface-${i}`);
      }
      root.style.removeProperty('--p-content-background');
      root.style.removeProperty('--p-content-hover-background');
      root.style.removeProperty('--p-content-border-color');
      
      // --- CRISP LIGHT MODE ---
      root.style.setProperty('--surface-ground', '#f8fafc');
      root.style.setProperty('--surface-section', '#ffffff');
      root.style.setProperty('--surface-card', '#ffffff');
      root.style.setProperty('--surface-overlay', '#ffffff');
      root.style.setProperty('--surface-border', '#e2e8f0');
      root.style.setProperty('--surface-hover', '#f1f5f9');
      root.style.setProperty('--text-color', '#0f172a');
      root.style.setProperty('--text-color-secondary', '#64748b');

      // Strip PrimeNG dark overrides to restore pure light mode
      root.style.removeProperty('--p-surface-950');
      root.style.removeProperty('--p-surface-900');
      root.style.removeProperty('--p-surface-800');
      root.style.removeProperty('--p-surface-700');
      root.style.removeProperty('--p-content-background');
      root.style.removeProperty('--p-content-hover-background');
    }
    this.applyTheme(this.currentTheme());
  }
}
