import type {
  CompleteResult,
  Problem,
  RespondentSurvey,
  SaveResponseRequest,
  SaveResponseResult,
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

async function request<T>(method: string, url: string, key: string | null, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { 'X-Response-Key': key } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      keepalive: method !== 'GET',
    });
  } catch {
    throw new ApiError(0, null); // offline or network error
  }
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw new ApiError(res.status, (json as Problem) ?? null);
  return json as T;
}

declare global {
  interface Window {
    __surveyPrefetch?: Promise<{ status: number; body: unknown; key: string | null }>;
  }
}

export async function loadSurvey(
  publicId: string,
  key: string | null,
  distribution: string | null,
): Promise<RespondentSurvey> {
  // Reuse the request index.html started before the bundle loaded, if it matches.
  const prefetch = window.__surveyPrefetch;
  window.__surveyPrefetch = undefined;
  if (prefetch) {
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
  return request<RespondentSurvey>('GET', `/r/v1/s/${publicId}${query}`, key);
}

export const saveResponse = (publicId: string, key: string, body: SaveResponseRequest) =>
  request<SaveResponseResult>('PUT', `/r/v1/s/${publicId}/response`, key, body);

export const completeResponse = (publicId: string, key: string, body: SaveResponseRequest) =>
  request<CompleteResult>('POST', `/r/v1/s/${publicId}/response/complete`, key, body);
