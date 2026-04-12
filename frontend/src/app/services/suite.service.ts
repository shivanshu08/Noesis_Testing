import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { TestSuite } from '../models/interfaces';

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
}
