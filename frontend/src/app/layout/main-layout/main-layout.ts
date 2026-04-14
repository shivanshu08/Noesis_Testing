import { Component, OnInit, OnDestroy, signal, computed, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, RouterOutlet, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { AvatarModule } from 'primeng/avatar';
import { MenuModule } from 'primeng/menu';
import { RippleModule } from 'primeng/ripple';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { PasswordModule } from 'primeng/password';
import { DividerModule } from 'primeng/divider';
import { FileUploadModule } from 'primeng/fileupload';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { MessageService } from 'primeng/api';
import { AlertOverlayComponent } from '../../components/alert-overlay/alert-overlay';
import { AuthService } from '../../services/auth.service';
import { ThemeService } from '../../services/theme.service';
import { ExecutionService } from '../../services/execution.service';
import { NotificationService } from '../../services/notification.service';

@Component({
  selector: 'app-main-layout',
  standalone: true,
  imports: [CommonModule, RouterModule, RouterOutlet, FormsModule, ButtonModule, TooltipModule, AvatarModule, MenuModule, RippleModule, DialogModule, InputTextModule, PasswordModule, DividerModule, FileUploadModule, IconFieldModule, InputIconModule, AlertOverlayComponent],
  providers: [MessageService],
  templateUrl: './main-layout.html',
  styleUrl: './main-layout.scss',
})
export class MainLayout implements OnInit, OnDestroy {
  sidebarCollapsed = signal(false);
  showThemeMenu = false;
  currentYear = new Date().getFullYear();
  showNotifications = false;
  showCommandPalette = false;
  searchQuery = '';
  private pollingInterval: any;

  navItems = computed(() => {
    const items = [
      { label: 'Dashboard', icon: 'pi pi-home', route: '/dashboard' },
      { label: 'Scripts', icon: 'pi pi-file-edit', route: '/scripts' },
        { label: 'Test Suites', icon: 'pi pi-sitemap', route: '/suites' },
    ];

    if (this.auth.canEdit()) {
      items.push({ label: 'Run Scripts', icon: 'pi pi-bolt', route: '/runner' });
    }

      items.push({ label: 'History', icon: 'pi pi-history', route: '/history' });

    if (this.auth.isAdmin()) {
      items.push({ label: 'User Management', icon: 'pi pi-users', route: '/users' });
    }

      // System diagnostics always at the absolute bottom
      items.push({ label: 'Logs', icon: 'pi pi-list', route: '/logs' });

    return items;
  });

  profileVisible = false;
  savingProfile = false;
  savingPassword = false;

  profileForm = { fullName: '', email: '', avatarUrl: '' };
  passwordForm = { currentPassword: '', newPassword: '', confirmPassword: '' };

  userMenuItems = [
    { label: 'Profile Settings', icon: 'pi pi-user-edit', command: () => this.openProfile() },
    { separator: true },
    { label: 'Logout', icon: 'pi pi-sign-out', command: () => this.auth.logout() }
  ];

  constructor(
    public auth: AuthService,
    public themeService: ThemeService,
    private http: HttpClient,
    private messageService: MessageService,
    private executionService: ExecutionService,
    public notificationService: NotificationService,
    private router: Router
  ) {}

  ngOnInit() {
    // Load historical notifications from database on init
    this.notificationService.load();
    
    // Bulletproof Auto-Refresh: Fetch DB notifications every 15 seconds
    this.pollingInterval = setInterval(() => this.notificationService.load(), 15000);

    this.executionService.initGlobalSocket();
    this.executionService.globalRunUpdates.subscribe((data) => {
      const severity = data.status === 'passed' ? 'success' : (data.status === 'error' || data.status === 'failed' ? 'error' : 'warn');
      const summary = `Execution ${data.status === 'passed' ? 'Passed' : 'Failed'}`;
      const detail = `Suite "${data.runName}" finished.`;
      const currentUrl = this.router.url || '';
      const isExecutionScreen = currentUrl.startsWith('/runner') || currentUrl.startsWith('/run/');
      if (!isExecutionScreen) {
        this.messageService.add({ severity, summary, detail, life: 6000 });
      }

      // Optimistic UI Update: Instantly show the notification so it NEVER looks empty!
      this.notificationService.notifications.update(n => [{
        id: Math.random().toString(36).substr(2, 9),
        severity,
        summary,
        detail,
        time: new Date(),
        icon: data.status === 'passed' ? 'pi pi-check' : 'pi pi-bolt',
        read: false
      }, ...n]);
      this.notificationService.unreadCount.update(c => c + 1);

      // Sync the exact DB IDs gracefully in the background 2 seconds later
      setTimeout(() => this.notificationService.load(), 2000);
    });
  }

  ngOnDestroy() {
    if (this.pollingInterval) clearInterval(this.pollingInterval);
  }

  toggleSidebar() {
    this.sidebarCollapsed.update(v => !v);
  }

  toggleNotifications() {
    this.showNotifications = !this.showNotifications;
    if (this.showNotifications) {
      this.showThemeMenu = false; // Close theme menu if open
    }
  }

  deleteNotification(event: Event, index: number) {
    // Safe fallback if needed, but the template handles it via ID now
    event.stopPropagation();
  }

  clearNotifications(event: Event) {
    event.stopPropagation();
    this.notificationService.clearAll();
  }

  toggleDarkMode() {
    this.themeService.toggleDarkMode();
  }

  openProfile() {
    const user = this.auth.user();
    if (user) {
      this.profileForm = {
        fullName: user.fullName || '',
        email: user.email || '',
        avatarUrl: user.avatarUrl || ''
      };
    }
    this.passwordForm = { currentPassword: '', newPassword: '', confirmPassword: '' };
    this.profileVisible = true;
  }

  onFileSelect(event: any) {
    const file = event.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e: any) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const MAX_SIZE = 256; // Shrink to a safe profile thumbnail size
          let width = img.width;
          let height = img.height;

          if (width > height) {
            if (width > MAX_SIZE) { height *= MAX_SIZE / width; width = MAX_SIZE; }
          } else {
            if (height > MAX_SIZE) { width *= MAX_SIZE / height; height = MAX_SIZE; }
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0, width, height);
            this.profileForm.avatarUrl = canvas.toDataURL('image/jpeg', 0.6); // Aggressive compression
          } else {
            this.profileForm.avatarUrl = e.target.result; // Fallback
          }
          this.messageService.add({ severity: 'info', summary: 'Photo Attached', detail: 'Click "Save Changes" to apply.' });
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    }
    if (event.options && event.options.clear) event.options.clear(); // Reset uploader state
  }

  saveProfile() {
    if (!this.profileForm.fullName || !this.profileForm.email) {
      this.messageService.add({ severity: 'error', summary: 'Required', detail: 'Name and Email are required.' });
      return;
    }
    this.savingProfile = true;

    const payload: any = {
      fullName: this.profileForm.fullName,
      email: this.profileForm.email,
      avatarUrl: this.profileForm.avatarUrl
    };

    this.http.put('/api/auth/profile', payload).subscribe({
      next: () => {
        this.savingProfile = false;
        this.messageService.add({ severity: 'success', summary: 'Success', detail: 'Profile updated successfully.' });
        this.profileVisible = false;
        // Fetch updated profile data instantly without a harsh page reload
        this.auth.fetchProfile().subscribe();
      },
      error: (err) => {
        this.savingProfile = false;
        console.error('Profile save error:', err);
        const errorMsg = err.error?.error || err.message || 'Network error: Could not reach the server.';
        this.messageService.add({ severity: 'error', summary: 'Error', detail: errorMsg });
      }
    });
  }

  updatePassword() {
    if (!this.passwordForm.currentPassword || !this.passwordForm.newPassword) return;
    if (this.passwordForm.newPassword !== this.passwordForm.confirmPassword) {
      this.messageService.add({ severity: 'error', summary: 'Mismatch', detail: 'New passwords do not match.' });
      return;
    }
    this.savingPassword = true;
    this.http.put('/api/auth/change-password', { currentPassword: this.passwordForm.currentPassword, newPassword: this.passwordForm.newPassword }).subscribe({
      next: () => {
        this.savingPassword = false;
        this.messageService.add({ severity: 'success', summary: 'Success', detail: 'Password changed successfully.' });
        this.passwordForm = { currentPassword: '', newPassword: '', confirmPassword: '' };
      },
      error: (err) => {
        this.savingPassword = false;
        this.messageService.add({ severity: 'error', summary: 'Error', detail: err.error?.error || 'Password change failed.' });
      }
    });
  }

  @HostListener('window:keydown.control.k', ['$event'])
  onCommandPalette(event: any) {
    if (this.auth.canEdit()) {
      event.preventDefault();
      this.showCommandPalette = !this.showCommandPalette;
    }
  }

  onPaletteCommandSelect(item: any) {
    this.showCommandPalette = false;
    this.router.navigate([item.route]);
  }
}

