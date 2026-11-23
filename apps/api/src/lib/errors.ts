export interface FieldIssue {
  path: string;
  code: string;
  message: string;
  pageKey?: string;
}

/** An expected error, rendered as RFC 9457 problem+json with a stable `code`. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly errors?: FieldIssue[],
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string) => new AppError(400, code, message);
export const unauthorized = (message = 'Log in to continue.') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = "You don't have permission to do that.", code = 'forbidden') =>
  new AppError(403, code, message);
/** Also used when the caller may not know the resource exists (never leak cross-tenant existence). */
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found.`);
export const conflict = (code: string, message: string, extra?: Record<string, unknown>) =>
  new AppError(409, code, message, undefined, extra);
export const gone = (code: string, message: string) => new AppError(410, code, message);
export const unprocessable = (code: string, message: string, errors?: FieldIssue[]) =>
  new AppError(422, code, message, errors);
export const tooManyRequests = (retryAfterSec: number) =>
  new AppError(429, 'rate_limited', 'Too many requests. Try again shortly.', undefined, { retryAfterSec });
