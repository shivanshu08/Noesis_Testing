import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, Subject } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  Script,
  ScriptCategory,
  ScriptConfigurationDetail,
  ScriptConfigurationFileContent,
  ScriptConfigurationChangeLog,
  ScriptConfigurationChangeLogDetail,
} from '../models/interfaces';

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

  getScriptConfiguration(id: number): Observable<ScriptConfigurationDetail> {
    return this.http.get<ScriptConfigurationDetail>(`${this.apiUrl}/${id}/configuration`);
  }

  getScriptConfigurationFileContent(scriptId: number, filePath: string): Observable<ScriptConfigurationFileContent> {
    let params = new HttpParams();
    params = params.set('path', filePath);
    return this.http.get<ScriptConfigurationFileContent>(`${this.apiUrl}/${scriptId}/configuration/file-content`, { params });
  }

  updateScriptConfigurationFile(scriptId: number, payload: { path: string; content: string }): Observable<{
    message: string;
    changed: boolean;
    file?: {
      path: string;
      fileName: string;
      fileType: string;
      fileSizeBytes?: number;
      lastModifiedAt?: string;
    };
    changeSummary?: Record<string, unknown>;
  }> {
    return this.http.put<{
      message: string;
      changed: boolean;
      file?: {
        path: string;
        fileName: string;
        fileType: string;
        fileSizeBytes?: number;
        lastModifiedAt?: string;
      };
      changeSummary?: Record<string, unknown>;
    }>(`${this.apiUrl}/${scriptId}/configuration/file`, payload);
  }

  getScriptConfigurationChanges(scriptId: number, limit = 40): Observable<ScriptConfigurationChangeLog[]> {
    let params = new HttpParams();
    params = params.set('limit', String(limit));
    return this.http.get<ScriptConfigurationChangeLog[]>(`${this.apiUrl}/${scriptId}/configuration/changes`, { params });
  }

  getScriptConfigurationChangeDetail(scriptId: number, changeId: number): Observable<ScriptConfigurationChangeLogDetail> {
    return this.http.get<ScriptConfigurationChangeLogDetail>(`${this.apiUrl}/${scriptId}/configuration/changes/${changeId}`);
  }

  getScriptConfigurationAttachment(
    scriptId: number,
    filePath: string,
    mode: 'open' | 'download'
  ): Observable<Blob> {
    let params = new HttpParams();
    params = params.set('path', filePath);
    params = params.set('mode', mode);
    return this.http.get(`${this.apiUrl}/${scriptId}/configuration/attachment`, {
      params,
      responseType: 'blob',
    });
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
