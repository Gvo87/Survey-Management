import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context that code deep in a request can read without it being passed down. Used so
 * audit entries written during an API-key request record the key, not the admin who created it.
 */
export interface RequestContext {
  apiKeyId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();
