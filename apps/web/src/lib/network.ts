import type {infer as ZodInfer, ZodSchema} from 'zod';

import {API_URI} from './constants';

interface Json {
  [x: string]: string | number | boolean | Date | Json | JsonArray;
}

type JsonArray = (string | number | boolean | Date | Json | JsonArray)[];

interface TypedSchema extends ZodSchema {
  _type: unknown;
}

interface ApiResponse {
  message?: string;
  error?: {
    message?: string;
    code?: string;
    [key: string]: unknown;
  };

  [key: string]: unknown;
}

export class network {
  public static async fetch<T, Schema extends TypedSchema | void = void>(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'PATCH',
    path: string,
    body?: Schema extends TypedSchema ? ZodInfer<Schema> : never,
  ): Promise<T> {
    const headers = network.projectHeaders();
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(network.url(path), {
      method,
      body: body && JSON.stringify(body),
      headers,
      credentials: 'include',
    });

    // Handle 204 No Content responses (no body to parse)
    if (response.status === 204) {
      return {} as T;
    }

    const res = (await response.json()) as ApiResponse;
    network.throwIfError(response, res);

    return res as T;
  }

  /**
   * Upload file using FormData (multipart/form-data)
   * Used for file uploads where Content-Type must be set by browser
   */
  public static async upload<T>(method: 'POST' | 'PUT' | 'PATCH', path: string, formData: FormData): Promise<T> {
    // DO NOT set Content-Type - browser will set it automatically with boundary
    let response: Response;
    try {
      response = await fetch(network.url(path), {
        method,
        body: formData,
        headers: network.projectHeaders(),
        credentials: 'include',
      });
    } catch {
      // Also what a body too large for the proxy looks like: nginx's 413 carries no CORS headers, so
      // the browser hides it from the dashboard and the request fails as a network error
      throw new Error('Couldn’t reach the server. The file may be too large, or the connection dropped.');
    }

    // A body too large for the proxy, on the API's own origin, is turned away by nginx with an HTML page
    const res = (await response.json().catch(() => null)) as ApiResponse | null;
    if (!res) {
      throw new Error(
        response.status === 413 ? 'The file is too large to upload' : `Upload failed (HTTP ${response.status})`,
      );
    }
    network.throwIfError(response, res);

    return res as T;
  }

  /**
   * Request a file and save it in the browser as `filename`. The name is chosen here because the
   * API runs on another origin and does not expose `Content-Disposition` to the dashboard.
   */
  public static async download<Schema extends TypedSchema>(
    method: 'GET' | 'POST',
    path: string,
    filename: string,
    body?: ZodInfer<Schema>,
  ): Promise<void> {
    const headers = network.projectHeaders();
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(network.url(path), {
      method,
      body: body && JSON.stringify(body),
      headers,
      credentials: 'include',
    });

    if (response.status >= 400) {
      network.throwIfError(response, (await response.json().catch(() => ({}))) as ApiResponse);
    }

    // Reading the whole body also surfaces a download cut short by the server as an error.
    const blob = await response.blob();
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    try {
      link.href = href;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
    } finally {
      link.remove();
      // Revoking in the same tick can cancel the download in some browsers (Safari).
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    }
  }

  private static url(path: string): string {
    return path.startsWith('http') ? path : API_URI + path;
  }

  private static projectHeaders(): Record<string, string> {
    // Get active project ID from localStorage
    const activeProjectId = typeof window !== 'undefined' ? localStorage.getItem('activeProjectId') : null;

    const headers: Record<string, string> = {};
    if (activeProjectId) {
      headers['X-Project-Id'] = activeProjectId;
    }
    return headers;
  }

  private static throwIfError(response: Response, res: ApiResponse): void {
    if (response.status < 400) {
      return;
    }

    // Check if this is an email verification required error
    if (res.error?.code === 'EMAIL_VERIFICATION_REQUIRED') {
      // Redirect to verification page
      if (typeof window !== 'undefined' && !window.location.href.includes('/auth/verify-email')) {
        window.location.href = '/auth/verify-email';
      }
      throw new Error(res.error.message ?? 'Please verify your email address to continue');
    }

    // Extract error message from standardized error response or fall back to direct message property
    const errorMessage = res.error?.message ?? res.message ?? 'Something went wrong!';
    // The API's error code travels with the message, for callers that answer some errors apart
    throw Object.assign(new Error(errorMessage), {code: res.error?.code});
  }
}
