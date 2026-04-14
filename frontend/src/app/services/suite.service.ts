import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { TestSuite, SuiteAuditLog } from '../models/interfaces';

@Injectable({ providedIn: 'root' })
export class SuiteService {
  private readonly apiUrl = `${environment.apiUrl}/suites`;

  constructor(private http: HttpClient) {}

  getSuites(): Observable<TestSuite[]> {
    return this.http.get<TestSuite[]>(this.apiUrl);
  }

  getSuite(id: number): Observable<TestSuite> {
    return this.http.get<TestSuite>(`${this.apiUrl}/${id}`);
  }

  createSuite(data: {
    name: string;
    description?: string;
    scriptIds: number[];
    isParallel?: boolean;
    threadCount?: number;
    tags?: string[];
  }): Observable<any> {
    return this.http.post(this.apiUrl, data);
  }

  updateSuite(id: number, data: Partial<TestSuite & { scriptIds: number[] }>): Observable<any> {
    return this.http.put(`${this.apiUrl}/${id}`, data);
  }

  deleteSuite(id: number): Observable<any> {
    return this.http.delete(`${this.apiUrl}/${id}`);
  }

  duplicateSuite(id: number): Observable<{ id: number; name: string; message: string }> {
    return this.http.post<{ id: number; name: string; message: string }>(`${this.apiUrl}/${id}/duplicate`, {});
  }

  getSuiteAuditLogs(filters?: {
    suiteId?: number;
    action?: string;
    limit?: number;
    days?: number;
  }): Observable<SuiteAuditLog[]> {
    let params = new HttpParams();
    if (filters?.suiteId !== undefined) params = params.set('suiteId', String(filters.suiteId));
    if (filters?.action) params = params.set('action', filters.action);
    if (filters?.limit !== undefined) params = params.set('limit', String(filters.limit));
    if (filters?.days !== undefined) params = params.set('days', String(filters.days));
    return this.http.get<SuiteAuditLog[]>(`${this.apiUrl}/audit`, { params });
  }
}
