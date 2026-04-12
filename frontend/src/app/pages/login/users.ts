import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { TableModule } from 'primeng/table';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { PasswordModule } from 'primeng/password';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { CheckboxModule } from 'primeng/checkbox';
import { AvatarModule } from 'primeng/avatar';
import { InputGroupModule } from 'primeng/inputgroup';
import { InputGroupAddonModule } from 'primeng/inputgroupaddon';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { FileUploadModule } from 'primeng/fileupload';
import { TooltipModule } from 'primeng/tooltip';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-users',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, CardModule, ButtonModule, DialogModule, InputTextModule, PasswordModule, SelectModule, TagModule, CheckboxModule, ConfirmDialogModule, AvatarModule, InputGroupModule, InputGroupAddonModule, FileUploadModule, TooltipModule],
  providers: [ConfirmationService],
  templateUrl: './users.html',
  styleUrls: ['./users.scss']
})
export class Users implements OnInit {
  users = signal<any[]>([]);
  loading = signal(true);
  userDialog = false;
  userForm: any = {};
  isEdit = false;

  // New Statistics Signals
  totalRuns = signal(0);
  totalSuites = signal(0);
  totalScripts = signal(0);
  activeCount = signal(0);

  roles = [
    { label: 'Admin', value: 'admin' },
    { label: 'Tester', value: 'tester' },
    { label: 'Viewer', value: 'viewer' }
  ];

  constructor(
    private http: HttpClient, 
    private messageService: MessageService, 
    private confirmationService: ConfirmationService,
    private authService: AuthService
  ) {}

  ngOnInit() {
    this.loadUsers();
  }

  private getHeaders() {
    return new HttpHeaders().set('Authorization', `Bearer ${this.authService.getToken()}`);
  }

  loadUsers() {
    this.loading.set(true);
    this.http.get<any[]>('http://localhost:3000/api/users', { headers: this.getHeaders() }).subscribe({
      next: (data) => {
        this.users.set(data);
        
        // Calculate Statistics
        this.totalRuns.set(data.reduce((acc, user) => acc + (user.run_count || 0), 0));
        this.totalSuites.set(data.reduce((acc, user) => acc + (user.suites_created || 0), 0));
        this.totalScripts.set(data.reduce((acc, user) => acc + (user.scripts_registered || 0), 0));
        this.activeCount.set(data.filter(user => user.is_active).length);
        
        this.loading.set(false);
      },
      error: (err) => {
        this.messageService.add({ severity: 'error', summary: 'Error', detail: 'Failed to load users.' });
        this.loading.set(false);
      }
    });
  }

  openNew() {
    this.userForm = { role: 'tester', isActive: true, avatarUrl: '' };
    this.isEdit = false;
    this.userDialog = true;
  }

  editUser(user: any) {
    this.userForm = { ...user, fullName: user.full_name, isActive: user.is_active, avatarUrl: user.avatar_url };
    this.isEdit = true;
    this.userDialog = true;
  }

  onFileSelect(event: any) {
    const file = event.target?.files?.[0] || event.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e: any) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const MAX_SIZE = 150;
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
            this.userForm = { ...this.userForm, avatarUrl: canvas.toDataURL('image/jpeg', 0.6) };
          } else {
            this.userForm = { ...this.userForm, avatarUrl: e.target.result };
          }
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    }
    if (event.target) event.target.value = ''; // Reset native input
    if (event.options && event.options.clear) event.options.clear();
  }

  saveUser() {
    const headers = this.getHeaders();
    const request = this.isEdit 
      ? this.http.put(`http://localhost:3000/api/users/${this.userForm.id}`, this.userForm, { headers })
      : this.http.post('http://localhost:3000/api/users', this.userForm, { headers });

    request.subscribe({
      next: () => {
        this.messageService.add({ severity: 'success', summary: 'Successful', detail: `User ${this.isEdit ? 'Updated' : 'Created'}` });
        this.userDialog = false;
        this.loadUsers();
      },
      error: (err) => this.messageService.add({ severity: 'error', summary: 'Error', detail: err.error?.error || 'Failed to save user' })
    });
  }

  deleteUser(user: any) {
    this.confirmationService.confirm({
      message: 'Are you sure you want to delete ' + user.username + '?',
      header: 'Confirm',
      icon: 'pi pi-exclamation-triangle',
      accept: () => {
        this.http.delete(`http://localhost:3000/api/users/${user.id}`, { headers: this.getHeaders() }).subscribe({
          next: () => {
            this.messageService.add({ severity: 'success', summary: 'Successful', detail: 'User Deleted' });
            this.loadUsers();
          },
          error: (err) => this.messageService.add({ severity: 'error', summary: 'Error', detail: err.error?.error || 'Failed to delete user' })
        });
      }
    });
  }
}