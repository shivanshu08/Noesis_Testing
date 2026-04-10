import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, RouterOutlet } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { AvatarModule } from 'primeng/avatar';
import { MenuModule } from 'primeng/menu';
import { RippleModule } from 'primeng/ripple';
import { AuthService } from '../../services/auth.service';
import { ThemeService } from '../../services/theme.service';

@Component({
  selector: 'app-main-layout',
  standalone: true,
  imports: [CommonModule, RouterModule, RouterOutlet, ButtonModule, TooltipModule, AvatarModule, MenuModule, RippleModule],
  templateUrl: './main-layout.html',
  styleUrl: './main-layout.scss',
})
export class MainLayout {
  sidebarCollapsed = signal(false);
  showThemeMenu = false;
  currentYear = new Date().getFullYear();

  navItems = [
    { label: 'Dashboard', icon: 'pi pi-objects-column', route: '/dashboard' },
    { label: 'Scripts', icon: 'pi pi-file-edit', route: '/scripts' },
    { label: 'Run Scripts', icon: 'pi pi-play', route: '/runner' },
    { label: 'Test Suites', icon: 'pi pi-sitemap', route: '/suites' },
    { label: 'History', icon: 'pi pi-history', route: '/history' },
  ];

  constructor(public auth: AuthService, public themeService: ThemeService) {}

  toggleSidebar() {
    this.sidebarCollapsed.update(v => !v);
  }
}
