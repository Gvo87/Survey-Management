import type { Me, Problem } from '@survey/contracts';

let csrfToken: string | null = null;
let activeOrgId: string | null = null;

/** Called whenever /auth/me (or login, signup, switch-org) returns. */
export function setSession(me: Me | null): void {
  csrfToken = me?.csrfToken ?? null;
  activeOrgId = me?.activeOrg?.id ?? null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: (Problem & Record<string, unknown>) | null,
  ) {
    super(
      problem?.title ??
        (status === 0 ? "Can't reach the server. Check your connection." : `Request failed (${status})`),
    );
  }
  get code(): string | undefined {
    return this.problem?.code;
  }
  /** Field errors keyed by path (for forms). */
  fieldErrors(): Record<string, string> {
    return Object.fromEntries((this.problem?.errors ?? []).map((e) => [e.path, e.message]));
  }
}

export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(csrfToken && method !== 'GET' ? { 'X-CSRF-Token': csrfToken } : {}),
        ...(activeOrgId ? { 'X-Org-Id': activeOrgId } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, null);
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const problem = data as ApiError['problem'];
    // Another tab switched organization: reload so this tab shows the right org.
    if (problem?.code === 'org_mismatch') window.location.assign('/surveys');
    throw new ApiError(res.status, problem);
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body?: unknown) => api<T>('POST', path, body);
export const patch = <T>(path: string, body?: unknown) => api<T>('PATCH', path, body);
export const put = <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
  api<T>('PUT', path, body, headers);
export const del = <T = void>(path: string) => api<T>('DELETE', path);

/** Upload one file as multipart/form-data (same CSRF and organization headers as `api`). */
export async function upload<T>(path: string, file: File, fields: Record<string, string> = {}): Promise<T> {
  const form = new FormData();
  // Fields first: the server reads them before the file.
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  form.append('file', file, file.name);
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        ...(activeOrgId ? { 'X-Org-Id': activeOrgId } : {}),
      },
      body: form,
    });
  } catch {
    throw new ApiError(0, null);
  }
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw new ApiError(res.status, data as ApiError['problem']);
  return data as T;
}

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong.';
