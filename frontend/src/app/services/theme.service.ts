import { Injectable, signal } from '@angular/core';

export type ThemePresetName = 'Aura' | 'Lara' | 'Nora' | 'Drogevate';
export type ThemeColorMode = 'monochrome' | 'color';

export interface AppTheme {
  name: string;
  label: string;
  preset: ThemePresetName;
  primary: string;
  primaryDark: string;
  accent: string;
  sidebarBgLight: string;
  sidebarBgDark: string;
  sidebarActiveLight: string;
  sidebarActiveDark: string;
  sidebarTextLight: string;
  sidebarTextDark: string;
  sidebarMutedLight: string;
  sidebarMutedDark: string;
}

export interface ThemeSwatch {
  label: string;
  value: string;
}

export interface SurfaceSwatch extends ThemeSwatch {
  light: SurfaceScale;
  dark: SurfaceScale;
}

interface SurfaceScale {
  bg: string;
  surface: string;
  section: string;
  overlay: string;
  border: string;
  hover: string;
  text: string;
  muted: string;
}

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly presets: ThemePresetName[] = ['Aura', 'Lara', 'Nora', 'Drogevate'];

  private readonly colorPalettes: Record<ThemePresetName, ThemeSwatch[]> = {
    Aura: [
      { label: 'Indigo', value: '#6366f1' },
      { label: 'Sky', value: '#0ea5e9' },
      { label: 'Teal', value: '#14b8a6' },
      { label: 'Emerald', value: '#10b981' },
      { label: 'Amber', value: '#f59e0b' },
      { label: 'Rose', value: '#f43f5e' },
      { label: 'Violet', value: '#8b5cf6' },
      { label: 'Pink', value: '#ec4899' }
    ],
    Lara: [
      { label: 'Blue', value: '#3b82f6' },
      { label: 'Cyan', value: '#06b6d4' },
      { label: 'Green', value: '#22c55e' },
      { label: 'Orange', value: '#f97316' },
      { label: 'Purple', value: '#a855f7' },
      { label: 'Fuchsia', value: '#d946ef' },
      { label: 'Slate', value: '#64748b' },
      { label: 'Zinc', value: '#71717a' }
    ],
    Nora: [
      { label: 'Sapphire', value: '#2563eb' },
      { label: 'Azure', value: '#0284c7' },
      { label: 'Mint', value: '#059669' },
      { label: 'Lime', value: '#65a30d' },
      { label: 'Plum', value: '#7c3aed' },
      { label: 'Magenta', value: '#c026d3' },
      { label: 'Coral', value: '#e11d48' },
      { label: 'Graphite', value: '#475569' }
    ],
    Drogevate: [
      { label: 'Drogevate Blue', value: '#204985' },
      { label: 'Deep Navy', value: '#173b6d' },
      { label: 'Clinical Blue', value: '#2f67a7' },
      { label: 'Signal Cyan', value: '#1aa7c8' },
      { label: 'Digital Teal', value: '#18b7a6' },
      { label: 'Action Orange', value: '#ff6b2c' },
      { label: 'Review Amber', value: '#f5a623' },
      { label: 'Alert Rose', value: '#e83e6f' }
    ]
  };

  private readonly monochromePalettes: Record<ThemePresetName, ThemeSwatch[]> = {
    Aura: [
      { label: 'Slate', value: '#334155' },
      { label: 'Zinc', value: '#52525b' },
      { label: 'Neutral', value: '#525252' },
      { label: 'Stone', value: '#57534e' }
    ],
    Lara: [
      { label: 'Steel', value: '#475569' },
      { label: 'Gray', value: '#4b5563' },
      { label: 'Zinc', value: '#3f3f46' },
      { label: 'Charcoal', value: '#374151' }
    ],
    Nora: [
      { label: 'Graphite', value: '#374151' },
      { label: 'Smoke', value: '#52525b' },
      { label: 'Ash', value: '#64748b' },
      { label: 'Ink', value: '#1f2937' }
    ],
    Drogevate: [
      { label: 'Navy Mono', value: '#244569' },
      { label: 'Blue Gray', value: '#3d5875' },
      { label: 'Slate Blue', value: '#50657e' },
      { label: 'Cool Steel', value: '#64748b' }
    ]
  };

  readonly surfaceSwatches: SurfaceSwatch[] = [
    {
      label: 'Slate',
      value: '#cbd5e1',
      light: { bg: '#f4f7fb', surface: '#ffffff', section: '#ffffff', overlay: '#ffffff', border: '#dbe3ee', hover: '#edf2f7', text: '#102033', muted: '#64748b' },
      dark: { bg: '#0f172a', surface: '#1e293b', section: '#111827', overlay: '#1e293b', border: '#334155', hover: '#26344a', text: '#f8fafc', muted: '#94a3b8' }
    },
    {
      label: 'Neutral',
      value: '#d4d4d4',
      light: { bg: '#f7f7f7', surface: '#ffffff', section: '#ffffff', overlay: '#ffffff', border: '#dedede', hover: '#f0f0f0', text: '#171717', muted: '#737373' },
      dark: { bg: '#111111', surface: '#1f1f1f', section: '#181818', overlay: '#242424', border: '#3a3a3a', hover: '#2d2d2d', text: '#fafafa', muted: '#a3a3a3' }
    },
    {
      label: 'Zinc',
      value: '#a1a1aa',
      light: { bg: '#f7f7fa', surface: '#ffffff', section: '#ffffff', overlay: '#ffffff', border: '#dedee6', hover: '#f1f1f5', text: '#18181b', muted: '#71717a' },
      dark: { bg: '#101014', surface: '#1d1d23', section: '#17171c', overlay: '#24242b', border: '#3f3f46', hover: '#2a2a32', text: '#fafafa', muted: '#a1a1aa' }
    },
    {
      label: 'Stone',
      value: '#d6d3d1',
      light: { bg: '#f8f7f5', surface: '#ffffff', section: '#ffffff', overlay: '#ffffff', border: '#e2dfdc', hover: '#f1efed', text: '#1c1917', muted: '#78716c' },
      dark: { bg: '#171412', surface: '#24201d', section: '#1d1a18', overlay: '#2b2622', border: '#44403c', hover: '#312c28', text: '#fafaf9', muted: '#a8a29e' }
    }
  ];

  private currentPreset = signal<ThemePresetName>(this.loadPreset());
  readonly preset = this.currentPreset.asReadonly();

  private colorMode = signal<ThemeColorMode>(this.loadColorMode());
  readonly mode = this.colorMode.asReadonly();

  private selectedSurface = signal<SurfaceSwatch>(this.loadSurface());
  readonly surface = this.selectedSurface.asReadonly();

  private currentTheme = signal<AppTheme>(this.loadTheme());
  readonly theme = this.currentTheme.asReadonly();

  private darkMode = signal<boolean>(this.loadDarkMode());
  readonly isDarkMode = this.darkMode.asReadonly();

  constructor() {
    this.applyDarkMode(this.darkMode());
    this.applyTheme(this.currentTheme());
  }

  primarySwatches(): ThemeSwatch[] {
    return this.colorMode() === 'monochrome'
      ? this.monochromePalettes[this.currentPreset()]
      : this.colorPalettes[this.currentPreset()];
  }

  setPreset(preset: ThemePresetName): void {
    this.currentPreset.set(preset);
    localStorage.setItem('noesis_theme_preset', preset);

    const selectedPalette = this.colorMode() === 'monochrome' ? this.monochromePalettes[preset] : this.colorPalettes[preset];
    const currentPrimary = this.currentTheme().primary.toLowerCase();
    const matchingSwatch = selectedPalette.find(swatch => swatch.value.toLowerCase() === currentPrimary) || selectedPalette[0];
    this.setCustomPrimary(matchingSwatch.value, matchingSwatch.label, preset);
  }

  setColorMode(mode: ThemeColorMode): void {
    this.colorMode.set(mode);
    localStorage.setItem('noesis_theme_color_mode', mode);
    const palette = mode === 'monochrome' ? this.monochromePalettes[this.currentPreset()] : this.colorPalettes[this.currentPreset()];
    const matchingSwatch = palette.find(swatch => swatch.value.toLowerCase() === this.currentTheme().primary.toLowerCase()) || palette[0];
    this.setCustomPrimary(matchingSwatch.value, matchingSwatch.label, this.currentPreset());
  }

  setSurface(label: string): void {
    const nextSurface = this.surfaceSwatches.find(surface => surface.label === label) || this.surfaceSwatches[0];
    this.selectedSurface.set(nextSurface);
    localStorage.setItem('noesis_theme_surface', nextSurface.label);
    this.applyDarkMode(this.darkMode());
  }

  setTheme(theme: AppTheme): void {
    this.currentPreset.set(theme.preset || this.currentPreset());
    this.currentTheme.set(theme);
    localStorage.setItem('noesis_theme', theme.name);
    localStorage.setItem('noesis_theme_preset', theme.preset || this.currentPreset());
    this.applyTheme(theme);
  }

  toggleDarkMode(): void {
    this.setDarkMode(!this.darkMode());
  }

  setDarkMode(newMode: boolean): void {
    this.darkMode.set(newMode);
    localStorage.setItem('noesis_dark_mode', newMode ? 'true' : 'false');
    this.applyDarkMode(newMode);
  }

  setCustomPrimary(primary: string, label: string, preset = this.currentPreset()): void {
    const theme = this.createTheme(primary, label, preset);
    this.currentTheme.set(theme);
    localStorage.setItem('noesis_theme', theme.name);
    localStorage.setItem('noesis_theme_preset', preset);
    localStorage.setItem('noesis_custom_primary', JSON.stringify(theme));
    this.applyTheme(theme);
  }

  chartPalette(): string[] {
    const primary = this.currentTheme().primary;
    const accent = this.currentTheme().accent;
    return [
      primary,
      this.mixWithWhite(primary, this.darkMode() ? 0.22 : 0.16),
      accent,
      '#22c55e',
      '#f59e0b',
      '#ef4444',
      '#06b6d4',
      '#8b5cf6'
    ];
  }

  private createTheme(primary: string, label: string, preset: ThemePresetName): AppTheme {
    const [r, g, b] = this.hexToRgb(primary);
    const isDrogevate = preset === 'Drogevate';

    return {
      name: `${preset.toLowerCase()}-${primary.replace('#', '')}`,
      label,
      preset,
      primary,
      primaryDark: this.mixWithBlack(primary, isDrogevate ? 0.22 : 0.14),
      accent: isDrogevate ? '#9ed8f5' : this.mixWithWhite(primary, 0.32),
      sidebarBgLight: isDrogevate ? '#204985' : '#ffffff',
      sidebarBgDark: isDrogevate ? '#14345f' : '#111827',
      sidebarActiveLight: isDrogevate ? 'rgba(255, 255, 255, 0.14)' : `rgba(${r}, ${g}, ${b}, 0.12)`,
      sidebarActiveDark: isDrogevate ? 'rgba(158, 216, 245, 0.18)' : `rgba(${r}, ${g}, ${b}, 0.18)`,
      sidebarTextLight: isDrogevate ? '#ffffff' : '#0f172a',
      sidebarTextDark: '#f8fafc',
      sidebarMutedLight: isDrogevate ? '#c4d9f3' : '#64748b',
      sidebarMutedDark: isDrogevate ? '#bdd4f4' : '#94a3b8'
    };
  }

  private loadTheme(): AppTheme {
    const saved = localStorage.getItem('noesis_theme');
    const custom = localStorage.getItem('noesis_custom_primary');

    if (custom) {
      try {
        const parsed = JSON.parse(custom) as Partial<AppTheme>;
        if (parsed.primary && parsed.label) {
          return this.createTheme(parsed.primary, parsed.label, parsed.preset || this.loadPreset());
        }
      } catch {
        localStorage.removeItem('noesis_custom_primary');
      }
    }

    const legacyTheme = this.legacyThemes.find(theme => theme.name === saved);
    if (legacyTheme) {
      return this.createTheme(legacyTheme.primary, legacyTheme.label, 'Aura');
    }

    const preset = this.loadPreset();
    const palette = this.loadColorMode() === 'monochrome' ? this.monochromePalettes[preset] : this.colorPalettes[preset];
    return this.createTheme(palette[0].value, palette[0].label, preset);
  }

  private loadPreset(): ThemePresetName {
    const saved = localStorage.getItem('noesis_theme_preset') as ThemePresetName | null;
    return saved && this.presets.includes(saved) ? saved : 'Aura';
  }

  private loadColorMode(): ThemeColorMode {
    return localStorage.getItem('noesis_theme_color_mode') === 'monochrome' ? 'monochrome' : 'color';
  }

  private loadSurface(): SurfaceSwatch {
    const saved = localStorage.getItem('noesis_theme_surface');
    return this.surfaceSwatches.find(surface => surface.label === saved) || this.surfaceSwatches[0];
  }

  private loadDarkMode(): boolean {
    const saved = localStorage.getItem('noesis_dark_mode');
    return saved === null ? false : saved === 'true';
  }

  private applyTheme(theme: AppTheme): void {
    const root = document.documentElement;
    const isDark = this.darkMode();
    const [r, g, b] = this.hexToRgb(theme.primary);

    root.dataset['noesisPreset'] = theme.preset.toLowerCase();
    root.style.setProperty('--noesis-primary', theme.primary);
    root.style.setProperty('--noesis-primary-rgb', `${r}, ${g}, ${b}`);
    root.style.setProperty('--noesis-primary-dark', theme.primaryDark);
    root.style.setProperty('--noesis-accent', theme.accent);
    root.style.setProperty('--noesis-sidebar-bg', isDark ? theme.sidebarBgDark : theme.sidebarBgLight);
    root.style.setProperty('--noesis-sidebar-active', isDark ? theme.sidebarActiveDark : theme.sidebarActiveLight);
    root.style.setProperty('--noesis-sidebar-text', isDark ? theme.sidebarTextDark : theme.sidebarTextLight);
    root.style.setProperty('--noesis-sidebar-muted', isDark ? theme.sidebarMutedDark : theme.sidebarMutedLight);

    root.style.setProperty('--primary-color', theme.primary);
    root.style.setProperty('--p-primary-color', theme.primary);
    root.style.setProperty('--p-primary-500', theme.primary);
    root.style.setProperty('--p-primary-600', theme.primaryDark);
    root.style.setProperty('--p-primary-400', theme.accent);
  }

  private applyDarkMode(isDark: boolean): void {
    const root = document.documentElement;
    const surface = isDark ? this.selectedSurface().dark : this.selectedSurface().light;

    root.classList.toggle('dark-mode', isDark);
    root.classList.toggle('p-dark', isDark);
    root.style.setProperty('--logo-filter', isDark ? 'brightness(0) invert(1)' : 'brightness(0)');

    root.style.setProperty('--noesis-bg', surface.bg);
    root.style.setProperty('--noesis-surface', surface.surface);
    root.style.setProperty('--noesis-text', surface.text);
    root.style.setProperty('--noesis-text-secondary', surface.muted);
    root.style.setProperty('--noesis-border', surface.border);

    root.style.setProperty('--surface-ground', surface.bg);
    root.style.setProperty('--surface-section', surface.section);
    root.style.setProperty('--surface-card', surface.surface);
    root.style.setProperty('--surface-overlay', surface.overlay);
    root.style.setProperty('--surface-border', surface.border);
    root.style.setProperty('--surface-hover', surface.hover);
    root.style.setProperty('--text-color', surface.text);
    root.style.setProperty('--text-color-secondary', surface.muted);

    root.style.setProperty('--p-content-background', surface.surface);
    root.style.setProperty('--p-content-hover-background', surface.hover);
    root.style.setProperty('--p-content-border-color', surface.border);
    root.style.setProperty('--p-surface-0', '#ffffff');
    root.style.setProperty('--p-surface-50', isDark ? '#f8fafc' : surface.bg);
    root.style.setProperty('--p-surface-100', isDark ? '#f1f5f9' : surface.hover);
    root.style.setProperty('--p-surface-200', surface.border);
    root.style.setProperty('--p-surface-700', isDark ? surface.border : '#475569');
    root.style.setProperty('--p-surface-800', isDark ? surface.overlay : '#334155');
    root.style.setProperty('--p-surface-900', isDark ? surface.surface : '#1e293b');
    root.style.setProperty('--p-surface-950', isDark ? surface.bg : '#0f172a');

    this.applyTheme(this.currentTheme());
  }

  private readonly legacyThemes: Array<Pick<AppTheme, 'name' | 'label' | 'primary'>> = [
    { name: 'indigo', label: 'Indigo', primary: '#6366f1' },
    { name: 'ocean', label: 'Ocean Blue', primary: '#0ea5e9' },
    { name: 'emerald', label: 'Emerald', primary: '#10b981' },
    { name: 'rose', label: 'Rose', primary: '#f43f5e' },
    { name: 'amber', label: 'Amber', primary: '#f59e0b' },
    { name: 'teal', label: 'Teal', primary: '#14b8a6' },
    { name: 'sunset', label: 'Sunset', primary: '#f97316' },
    { name: 'cyberpunk', label: 'Cyberpunk', primary: '#d946ef' },
    { name: 'midnight', label: 'Midnight', primary: '#8b5cf6' },
    { name: 'slate', label: 'Slate', primary: '#64748b' }
  ];

  private mixWithBlack(hex: string, amount: number): string {
    return this.mix(hex, '#000000', amount);
  }

  private mixWithWhite(hex: string, amount: number): string {
    return this.mix(hex, '#ffffff', amount);
  }

  private mix(hex: string, target: string, amount: number): string {
    const sourceRgb = this.hexToRgb(hex);
    const targetRgb = this.hexToRgb(target);
    const rgb = sourceRgb.map((channel, index) => Math.round(channel + (targetRgb[index] - channel) * amount));
    return `#${rgb.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
  }

  private hexToRgb(hex: string): [number, number, number] {
    const normalized = hex.replace('#', '');
    const value = normalized.length === 3
      ? normalized.split('').map(char => char + char).join('')
      : normalized;

    return [
      parseInt(value.slice(0, 2), 16),
      parseInt(value.slice(2, 4), 16),
      parseInt(value.slice(4, 6), 16)
    ];
  }
}
