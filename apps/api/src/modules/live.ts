/**
 * Live results (Phase 2B): Server-Sent Events. The worker publishes to Redis after it adds a
 * completed response to the aggregates; every API process relays the event to the dashboards it
 * serves. The dashboard refetches on each event and falls back to polling if the stream drops.
 */
import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { LiveEvent } from '@survey/contracts';
import { withTenant } from '@survey/db';
import type { Deps } from '../deps';
import { requireOrg } from '../auth/context';
import { loadSurvey } from './surveys';

const CHANNEL = 'live:survey:';
const HEARTBEAT_MS = 25_000;
const MAX_STREAMS = 2000;

export async function publishLiveEvent(redis: Redis, surveyId: string, event: LiveEvent): Promise<void> {
  await redis.publish(`${CHANNEL}${surveyId}`, JSON.stringify(event)).catch(() => {});
}

export function registerLiveRoutes(app: FastifyInstance, deps: Deps): void {
  const streams = new Map<string, Set<ServerResponse>>();
  let subscriber: Redis | null = null;
  let count = 0;

  async function ensureSubscriber() {
    if (subscriber) return;
    subscriber = deps.redis.duplicate();
    subscriber.on('error', (error) => app.log.warn({ err: error.message }, 'live subscriber error'));
    subscriber.on('pmessage', (_pattern, channel, message) => {
      const surveyId = channel.slice(CHANNEL.length);
      for (const res of streams.get(surveyId) ?? []) res.write(`event: update\ndata: ${message}\n\n`);
    });
    await subscriber.psubscribe(`${CHANNEL}*`);
  }

  app.addHook('onClose', async () => {
    for (const set of streams.values()) for (const res of set) res.end();
    subscriber?.disconnect();
  });

  app.get<{ Params: { id: string } }>('/api/v1/surveys/:id/live', async (req, reply) => {
    const auth = requireOrg(req);
    const survey = await withTenant(deps.pool, auth.orgId, async (tx) => (await loadSurvey(tx, auth, req.params.id, 'responses.view')).survey);
    if (count >= MAX_STREAMS) return reply.code(503).header('retry-after', '30').send({ code: 'busy', title: 'Live updates are busy; polling instead.' });
    await ensureSubscriber();

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 5000\nevent: ready\ndata: ${JSON.stringify({ completedCount: survey.completedCount })}\n\n`);
    if (!streams.has(survey.id)) streams.set(survey.id, new Set());
    streams.get(survey.id)!.add(res);
    count++;
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      count--;
      const set = streams.get(survey.id);
      set?.delete(res);
      if (set && set.size === 0) streams.delete(survey.id);
    });
  });
}
