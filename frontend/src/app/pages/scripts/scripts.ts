import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TooltipModule } from 'primeng/tooltip';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { ScriptService } from '../../services/script.service';
import { Script, ScriptCategory } from '../../models/interfaces';

@Component({
  selector: 'app-scripts',
  standalone: true,
  imports: [
    CommonModule, FormsModule, TableModule, CardModule, ButtonModule,
    InputTextModule, SelectModule, TagModule, ToggleSwitchModule,
    TooltipModule, IconFieldModule, InputIconModule,
  ],
  templateUrl: './scripts.html',
  styleUrl: './scripts.scss',
})
export class Scripts implements OnInit {
  scripts = signal<Script[]>([]);
  categories = signal<ScriptCategory[]>([]);
  filteredScripts = signal<Script[]>([]);
  loading = signal(true);
  syncing = signal(false);

  searchTerm = '';
  selectedCategory: number | null = null;

  constructor(private scriptService: ScriptService) {}

  ngOnInit() {
    this.loadCategories();
    this.loadScripts();
  }

  loadCategories() {
    this.scriptService.getCategories().subscribe({
      next: (data) => this.categories.set(data),
    });
  }

  loadScripts() {
    this.loading.set(true);
    this.scriptService.getScripts().subscribe({
      next: (data) => {
        this.scripts.set(data);
        this.applyFilters();
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  applyFilters() {
    let results = this.scripts();
    if (this.searchTerm) {
      const term = this.searchTerm.toLowerCase();
      results = results.filter(s =>
        s.name.toLowerCase().includes(term) ||
        s.className.toLowerCase().includes(term)
      );
    }
    if (this.selectedCategory) {
      results = results.filter(s => s.categoryId === this.selectedCategory);
    }
    this.filteredScripts.set(results);
  }

  onSearch() {
    this.applyFilters();
  }

  onCategoryChange() {
    this.applyFilters();
  }

  toggleScript(script: Script) {
    this.scriptService.updateScript(script.id, { isActive: !script.isActive }).subscribe({
      next: () => {
        const updated = this.scripts().map(s =>
          s.id === script.id ? { ...s, isActive: !s.isActive } : s
        );
        this.scripts.set(updated);
        this.applyFilters();
      },
    });
  }

  syncScripts() {
    this.syncing.set(true);
    this.scriptService.syncScripts().subscribe({
      next: () => {
        this.loadScripts();
        this.syncing.set(false);
      },
      error: () => this.syncing.set(false),
    });
  }

  getCategoryName(categoryId: number): string {
    return this.categories().find(c => c.id === categoryId)?.name || 'Unknown';
  }

  getCategorySeverity(name: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast' {
    const map: Record<string, 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast'> = {
      Configuration: 'info',
      Feature: 'success',
      Sanity: 'warn',
      Manual: 'secondary',
      API: 'contrast',
      Dashboard: 'info',
      Security: 'danger',
      Intake: 'success',
    };
    return map[name] || 'secondary';
  }
}
