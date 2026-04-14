import { Component, signal, OnInit, OnDestroy, Inject } from '@angular/core';
import { CommonModule, DOCUMENT } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { InputTextModule } from 'primeng/inputtext';
import { PasswordModule } from 'primeng/password';
import { ButtonModule } from 'primeng/button';
import { MessageModule } from 'primeng/message';
import { CheckboxModule } from 'primeng/checkbox';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputGroupModule } from 'primeng/inputgroup';
import { InputGroupAddonModule } from 'primeng/inputgroupaddon';
import { CardModule } from 'primeng/card';
import { DividerModule } from 'primeng/divider';
import { FloatLabelModule } from 'primeng/floatlabel';
import { SelectModule } from 'primeng/select';
import { MessageService } from 'primeng/api';
import { AlertOverlayComponent } from '../../components/alert-overlay/alert-overlay';
import { AuthService } from '../../services/auth.service';
import { ThemeService } from '../../services/theme.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [
    CommonModule, FormsModule, InputTextModule, PasswordModule, ButtonModule,
    MessageModule, CheckboxModule, IconFieldModule, InputIconModule,
    InputGroupModule, InputGroupAddonModule, CardModule, DividerModule,
    FloatLabelModule, SelectModule, AlertOverlayComponent
  ],
  providers: [MessageService],
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class Login implements OnInit, OnDestroy {
  username = '';
  password = '';
  showPassword = false;
  loading = signal(false);
  error = signal('');
  successMsg = signal('');
  currentYear = new Date().getFullYear();

  constructor(
    private auth: AuthService,
    private router: Router,
    public themeService: ThemeService,
    private messageService: MessageService,
    @Inject(DOCUMENT) private document: Document
  ) {}

  ngOnInit() {
    // Force Light Mode strictly for the Login page
    this.document.documentElement.classList.remove('dark-mode', 'p-dark');
  }

  ngOnDestroy() {
    // Restore global dark mode preference when leaving login
    if (this.themeService.isDarkMode()) {
      this.document.documentElement.classList.add('dark-mode', 'p-dark');
    }
  }

  onLogin() {
    if (!this.username || !this.password) {
      this.messageService.add({ severity: 'warn', summary: 'Required', detail: 'Please enter username and password.' });
      return;
    }
    this.loading.set(true);

    this.auth.login({ username: this.username, password: this.password }).subscribe({
      next: () => {
        this.loading.set(false);
        this.router.navigate(['/dashboard']);
      },
      error: (err) => {
        this.loading.set(false);
        this.messageService.add({ severity: 'error', summary: 'Authentication Failed', detail: err.error?.error || 'Login failed. Please try again.' });
      },
    });
  }
}
