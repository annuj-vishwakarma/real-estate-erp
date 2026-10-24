import type { ApiFailure, ApiSuccess, ErrorCode, LoginResult, PageMeta } from '@erp/shared';

const BASE = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public details?: { path: string; message: string }[],
    public requestId?: string,
  ) {
    super(message);
  }
}

/**
 * Access token lives in memory only (never localStorage). The refresh token is an HttpOnly
 * cookie the browser sends to /auth/refresh; a CSRF double-submit header protects it.
 */
let accessToken: string | null = null;
let onSessionExpired: (() => void) | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}
export function setSessionExpiredHandler(fn: () => void) {
  onSessionExpired = fn;
}

function readCookie(name: string): string | undefined {
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${name}=`))
    ?.split('=')[1];
}

let refreshing: Promise<LoginResult | null> | null = null;

/** Single-flight refresh: concurrent 401s share one refresh request. */
export function refreshSession(): Promise<LoginResult | null> {
  refreshing ??= (async () => {
    // No CSRF cookie means there is no session cookie either; skip the round trip.
    if (!readCookie('erp_csrf')) return null;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(`${BASE}/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'x-csrf-token': readCookie('erp_csrf') ?? '' },
        });
        if (res.status === 409) {
          // Another tab rotated the token a moment ago; the cookie is already updated.
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        if (!res.ok) return null;
        const body = (await res.json()) as ApiSuccess<LoginResult>;
        setAccessToken(body.data.accessToken);
        return body.data;
      }
      return null;
    } catch {
      return null;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']) {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function rawRequest(path: string, opts: RequestOptions, retry = true): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  if (opts.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  const res = await fetch(buildUrl(path, opts.query), {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
    credentials: 'include',
    signal: opts.signal,
  });

  if (res.status === 401 && retry && !path.startsWith('/auth/')) {
    const refreshed = await refreshSession();
    if (refreshed) return rawRequest(path, opts, false);
    setAccessToken(null);
    onSessionExpired?.();
  }
  return res;
}

async function parse<T>(res: Response): Promise<{ data: T; meta?: PageMeta }> {
  let body: ApiSuccess<T> | ApiFailure;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(res.status, 'INTERNAL', `Unexpected response (${res.status})`);
  }
  if (!res.ok || !body.success) {
    const err = (body as ApiFailure).error ?? { code: 'INTERNAL', message: 'Request failed' };
    throw new ApiError(res.status, err.code, err.message, err.details, err.requestId);
  }
  return { data: body.data, meta: body.meta };
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  return (await parse<T>(await rawRequest(path, opts))).data;
}

export async function requestPage<T>(path: string, opts: RequestOptions = {}): Promise<{ items: T[]; meta: PageMeta }> {
  const { data, meta } = await parse<T[]>(await rawRequest(path, opts));
  return { items: data, meta: meta ?? { page: 1, pageSize: data.length, total: data.length, totalPages: 1 } };
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query']) => request<T>(path, { query }),
  page: <T>(path: string, query?: RequestOptions['query']) => requestPage<T>(path, { query }),
  post: <T>(path: string, body?: unknown, idempotencyKey?: string) =>
    request<T>(path, { method: 'POST', body: body ?? {}, idempotencyKey }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  /** Multipart upload (FormData); the browser sets the boundary header. */
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form }),
};

/** Downloads (PDF/Excel) go through the authenticated client, then open/save as a blob. */
export async function download(path: string, query?: RequestOptions['query'], mode: 'open' | 'save' = 'save') {
  const res = await rawRequest(path, { query });
  if (!res.ok) await parse(res);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const disposition = res.headers.get('content-disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'download';
  if (mode === 'open') {
    window.open(url, '_blank', 'noopener');
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || !err.details) return {};
  return Object.fromEntries(err.details.map((d) => [d.path, d.message]));
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}
