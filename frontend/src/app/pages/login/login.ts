import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { InputTextModule } from 'primeng/inputtext';
import { PasswordModule } from 'primeng/password';
import { ButtonModule } from 'primeng/button';
import { MessageModule } from 'primeng/message';
import { CheckboxModule } from 'primeng/checkbox';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, InputTextModule, PasswordModule, ButtonModule, MessageModule, CheckboxModule],
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class Login {
  username = '';
  password = '';
  fullName = '';
  email = '';
  confirmPassword = '';
  isRegister = signal(false);
  loading = signal(false);
  error = signal('');

  constructor(private auth: AuthService, private router: Router) {}

  onLogin() {
    if (!this.username || !this.password) {
      this.error.set('Please enter username and password.');
      return;
    }
    this.loading.set(true);
    this.error.set('');

    this.auth.login({ username: this.username, password: this.password }).subscribe({
      next: () => {
        this.loading.set(false);
        this.router.navigate(['/dashboard']);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(err.error?.error || 'Login failed. Please try again.');
      },
    });
  }

  onRegister() {
    if (!this.username || !this.email || !this.password || !this.fullName) {
      this.error.set('All fields are required.');
      return;
    }
    if (this.password !== this.confirmPassword) {
      this.error.set('Passwords do not match.');
      return;
    }
    if (this.password.length < 6) {
      this.error.set('Password must be at least 6 characters.');
      return;
    }
    this.loading.set(true);
    this.error.set('');

    this.auth.register({ username: this.username, email: this.email, password: this.password, fullName: this.fullName }).subscribe({
      next: () => {
        this.loading.set(false);
        this.isRegister.set(false);
        this.error.set('');
        this.password = '';
        this.confirmPassword = '';
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(err.error?.error || 'Registration failed.');
      },
    });
  }

  toggleMode() {
    this.isRegister.update(v => !v);
    this.error.set('');
  }
}
