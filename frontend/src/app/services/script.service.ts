import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, Subject } from 'rxjs';
import { environment } from '../../environments/environment';
import { Script, ScriptCategory } from '../models/interfaces';

@Injectable({ providedIn: 'root' })
export class ScriptService {
  private readonly apiUrl = `${environment.apiUrl}/scripts`;
  private readonly scriptRegistryUpdatedSubject = new Subject<void>();
  readonly scriptRegistryUpdated$ = this.scriptRegistryUpdatedSubject.asObservable();

  constructor(private http: HttpClient) {}

  getScripts(filters?: { category?: number; search?: string; active?: boolean }): Observable<Script[]> {
    let params = new HttpParams();
    if (filters?.category) params = params.set('category', filters.category.toString());
    if (filters?.search) params = params.set('search', filters.search);
    if (filters?.active !== undefined) params = params.set('active', filters.active.toString());
    return this.http.get<Script[]>(this.apiUrl, { params });
  }

  getCategories(): Observable<ScriptCategory[]> {
    return this.http.get<ScriptCategory[]>(`${this.apiUrl}/categories`);
  }

  getScript(id: number): Observable<Script> {
    return this.http.get<Script>(`${this.apiUrl}/${id}`);
  }

  updateScript(id: number, data: Partial<Script>): Observable<any> {
    return this.http.put(`${this.apiUrl}/${id}`, data);
  }

  syncScripts(): Observable<any> {
    return this.http.post(`${this.apiUrl}/sync`, {});
  }

  importScript(file: File): Observable<any> {
    const formData = new FormData();
    formData.append('file', file);
    return this.http.post(`${this.apiUrl}/import`, formData);
  }

  deleteScript(id: number): Observable<any> {
    return this.http.delete(`${this.apiUrl}/${id}`);
  }

  deleteScripts(ids: number[]): Observable<any> {
    return this.http.post(`${this.apiUrl}/delete-multiple`, { ids });
  }

  notifyScriptRegistryUpdated(): void {
    this.scriptRegistryUpdatedSubject.next();
  }
}
