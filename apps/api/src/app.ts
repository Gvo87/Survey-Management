import { randomBytes } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Problem } from '@survey/contracts';
import type { Deps } from './deps';
import { registerAuth } from './auth/context';
import { AppError } from './lib/errors';
import { captureError } from './lib/sentry';
import { registerAuthRoutes } from './modules/auth';
import { registerDistributionRoutes } from './modules/distributions';
import { registerOrgRoutes } from './modules/org';
import { registerRespondentRoutes } from './modules/respondent';
import { registerResultsRoutes } from './modules/results';
import { registerSurveyRoutes } from './modules/surveys';

/** Log the path only: query strings and invitation tokens can carry secrets. */
export function sanitizeUrl(url: string): string {
  return url.split('?')[0]!.replace(/(\/invitations\/)[^/]+/, '$1[token]');
}

export function loggerOptions(deps: Deps): FastifyServerOptions['logger'] {
  return {
    level: deps.config.logLevel,
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["x-csrf-token"]',
        'req.headers["x-response-key"]',
        'res.headers["set-cookie"]',
      ],
      censor: '[redacted]',
    },
    // No IP addresses, headers or bodies in logs.
    serializers: {
      req: (req: { method: string; url: string; id: string }) => ({
        method: req.method,
        url: sanitizeUrl(req.url),
        id: req.id,
      }),
    },
    ...(deps.config.env === 'development' && process.stdout.isTTY
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  };
}

export async function buildApp(
  deps: Deps,
  options: { logger?: FastifyServerOptions['logger'] } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? loggerOptions(deps),
    genReqId: () => `req_${randomBytes(8).toString('hex')}`,
    trustProxy: process.env.TRUST_PROXY === 'true',
    bodyLimit: 1024 * 1024,
  });

  // JSON only: cross-site HTML forms can't send application/json without a CORS preflight.
  app.removeContentTypeParser('text/plain');
  await app.register(cookie);
  registerAuth(app, deps);

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-request-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    if (req.url.startsWith('/api/') && !reply.hasHeader('cache-control'))
      reply.header('cache-control', 'no-store');
    return payload;
  });

  const sendProblem = (reply: import('fastify').FastifyReply, problem: Problem) =>
    reply.code(problem.status).type('application/problem+json').send(problem);

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      if (error.status === 429 && typeof error.extra?.retryAfterSec === 'number')
        reply.header('retry-after', String(error.extra.retryAfterSec));
      return sendProblem(reply, {
        type: `urn:survey:error:${error.code}`,
        title: error.message,
        status: error.status,
        code: error.code,
        ...(error.errors ? { errors: error.errors } : {}),
        ...(error.extra ?? {}),
        requestId: req.id,
      });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      const code =
        status === 415 ? 'unsupported_media_type' : status === 413 ? 'payload_too_large' : 'bad_request';
      return sendProblem(reply, {
        type: `urn:survey:error:${code}`,
        title: status === 415 ? 'Send JSON (Content-Type: application/json).' : (error as Error).message,
        status,
        code,
        requestId: req.id,
      });
    }
    req.log.error({ err: error }, 'unhandled error');
    captureError(error, { requestId: req.id, route: req.routeOptions.url });
    return sendProblem(reply, {
      type: 'urn:survey:error:internal_error',
      title: 'Something went wrong on our side. Please try again.',
      status: 500,
      code: 'internal_error',
      requestId: req.id,
    });
  });

  app.setNotFoundHandler((req, reply) =>
    sendProblem(reply, {
      type: 'urn:survey:error:not_found',
      title: 'Not found.',
      status: 404,
      code: 'not_found',
      requestId: req.id,
    }),
  );

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await deps.pool.query('select 1');
      await deps.redis.ping();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  registerAuthRoutes(app, deps);
  registerOrgRoutes(app, deps);
  registerSurveyRoutes(app, deps);
  registerDistributionRoutes(app, deps);
  registerRespondentRoutes(app, deps);
  registerResultsRoutes(app, deps);

  return app;
}
