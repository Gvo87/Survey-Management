import type {
  CompleteResult,
  Problem,
  RespondentSurvey,
  SaveResponseRequest,
  SaveResponseResult,
  UnlockResult,
  UploadedFile,
} from '@survey/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem | null,
  ) {
    super(problem?.title ?? `HTTP ${status}`);
  }
  /** Network failures and 5xx/429 are worth retrying; 4xx are final answers. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

// ── Password access token (Phase 2A): kept for the browser session only ─────
const accessKey = (publicId: string) => `sm:access:${publicId}`;
const memoryTokens = new Map<string, string>();
export function readAccessToken(publicId: string): string | null {
  const inMemory = memoryTokens.get(publicId);
  if (inMemory) return inMemory;
  try {
    return sessionStorage.getItem(accessKey(publicId));
  } catch {
    return null;
  }
}
function writeAccessToken(publicId: string, token: string): void {
  memoryTokens.set(publicId, token);
  try {
    sessionStorage.setItem(accessKey(publicId), token);
  } catch {
    // blocked storage: the in-memory copy lasts for this page
  }
}

function headers(publicId: string, key: string | null, json: boolean): Record<string, string> {
  const token = readAccessToken(publicId);
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(key ? { 'X-Response-Key': key } : {}),
    ...(token ? { 'X-Access-Token': token } : {}),
  };
}

async function send<T>(res: Promise<Response>): Promise<T> {
  let response: Response;
  try {
    response = await res;
  } catch {
    throw new ApiError(0, null); // offline or network error
  }
  const json = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) throw new ApiError(response.status, (json as Problem) ?? null);
  return json as T;
}

function request<T>(publicId: string, method: string, url: string, key: string | null, body?: unknown): Promise<T> {
  return send<T>(
    fetch(url, {
      method,
      headers: headers(publicId, key, body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      keepalive: method !== 'GET',
    }),
  );
}

declare global {
  interface Window {
    __surveyPrefetch?: Promise<{ status: number; body: unknown; key: string | null }>;
  }
}

export async function loadSurvey(publicId: string, key: string | null, distribution: string | null): Promise<RespondentSurvey> {
  // Reuse the request index.html started before the bundle loaded, if it matches.
  const prefetch = window.__surveyPrefetch;
  window.__surveyPrefetch = undefined;
  if (prefetch && !readAccessToken(publicId)) {
    try {
      const result = await prefetch;
      if (result.key === key) {
        if (result.status === 200) return result.body as RespondentSurvey;
        throw new ApiError(result.status, result.body as Problem);
      }
    } catch (error) {
      if (error instanceof ApiError && !error.retryable) throw error;
    }
  }
  const query = distribution ? `?d=${encodeURIComponent(distribution)}` : '';
  return request<RespondentSurvey>(publicId, 'GET', `/r/v1/s/${publicId}${query}`, key);
}

export async function unlock(publicId: string, password: string): Promise<void> {
  const { accessToken } = await request<UnlockResult>(publicId, 'POST', `/r/v1/s/${publicId}/unlock`, null, { password });
  writeAccessToken(publicId, accessToken);
}

export const saveResponse = (publicId: string, key: string, body: SaveResponseRequest) =>
  request<SaveResponseResult>(publicId, 'PUT', `/r/v1/s/${publicId}/response`, key, body);

export const completeResponse = (publicId: string, key: string, body: SaveResponseRequest) =>
  request<CompleteResult>(publicId, 'POST', `/r/v1/s/${publicId}/response/complete`, key, body);

export function uploadFile(publicId: string, key: string, questionKey: string, file: File): Promise<UploadedFile> {
  const form = new FormData();
  form.append('file', file, file.name);
  return send<UploadedFile>(
    fetch(`/r/v1/s/${publicId}/uploads?questionKey=${encodeURIComponent(questionKey)}`, {
      method: 'POST',
      headers: headers(publicId, key, false),
      body: form,
    }),
  );
}

export async function removeFile(publicId: string, key: string, fileId: string): Promise<void> {
  try {
    const res = await fetch(`/r/v1/s/${publicId}/uploads/${fileId}`, { method: 'DELETE', headers: headers(publicId, key, false) });
    if (!res.ok && res.status !== 404) throw new ApiError(res.status, null);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, null);
  }
}
