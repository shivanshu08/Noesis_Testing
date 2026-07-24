import { CommonModule } from '@angular/common';
import { Component, OnInit, Inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { PlatformId } from '../../models/interfaces';

export interface NoesisPlatform { id: PlatformId; name: string; description: string; icon: string; accent: string; destination: string; }

@Component({ selector: 'app-platform-launcher', standalone: true, imports: [CommonModule, RouterLink], templateUrl: './platform-launcher.html', styleUrl: './platform-launcher.scss' })
export class PlatformLauncher implements OnInit {
  readonly year = new Date().getFullYear();
  readonly platforms: NoesisPlatform[] = [
    { id: 'test-automation', name: 'Test Automation', description: 'Execute, monitor, and manage ST automation scripts and suites.', icon: 'pi-shield', accent: 'blue', destination: '/dashboard' },
    { id: 'csd-studio', name: 'CSD Studio', description: 'Generate and manage consistent, compliant CSD deliverables.', icon: 'pi-file-edit', accent: 'violet', destination: '/product/csd-studio' },
    { id: 'tenant-provisioning', name: 'Tenant Provisioning', description: 'Create, configure, and track customer tenant environments.', icon: 'pi-cog', accent: 'teal', destination: '/product/tenant-provisioning' }
  ];
  constructor(public auth: AuthService, private router: Router, @Inject(DOCUMENT) private document: Document) {}
  ngOnInit() { this.document.documentElement.classList.remove('dark-mode', 'p-dark'); }
  visiblePlatforms() { const access = this.auth.user()?.platformAccess; return this.auth.isLoggedIn() && access?.length ? this.platforms.filter(p => access.includes(p.id)) : this.platforms; }
  launch(platform: NoesisPlatform) { this.router.navigate(this.auth.isLoggedIn() ? [platform.destination] : ['/login', platform.id]); }
}