/**
 * Downloading uploaded files (admin side). A file is served only after its malware scan came
 * back clean, only to people who can view the survey's responses, and every download is audited.
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { files, withTenant } from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireOrg } from '../auth/context';
import { AppError, conflict, notFound } from '../lib/errors';
import { loadSurvey } from './surveys';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RFC 6266 / 5987 Content-Disposition that survives any filename. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function registerFileRoutes(app: FastifyInstance, deps: Deps): void {
  app.get<{ Params: { id: string } }>('/api/v1/files/:id', async (req, reply) => {
    const auth = requireOrg(req);
    if (!UUID.test(req.params.id)) throw notFound('File');
    const file = await withTenant(deps.pool, auth.orgId, async (tx) => {
      const [row] = await tx.db.select().from(files).where(eq(files.id, req.params.id));
      if (!row) throw notFound('File');
      if (row.surveyId) await loadSurvey(tx, auth, row.surveyId, 'responses.view');
      if (row.scanStatus === 'pending') throw conflict('scan_pending', 'This file is still being checked for malware. Try again in a moment.');
      if (row.scanStatus === 'infected') throw new AppError(403, 'file_quarantined', 'This file was quarantined because it contains malware.');
      if (row.scanStatus === 'error') throw conflict('scan_failed', "This file couldn't be checked for malware, so it can't be downloaded.");
      await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'file.downloaded', entityType: 'file', entityId: row.id, ip: req.ip });
      return row;
    });
    reply
      .header('content-type', file.mime)
      .header('content-disposition', contentDisposition(file.filename))
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'no-store');
    return reply.send(await deps.storage.stream(file.storageKey));
  });
}
