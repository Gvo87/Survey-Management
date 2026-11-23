/**
 * Themes (Phase 2A): colours, font, corner radius and a logo. Org admins manage them; anyone who
 * can edit a survey can pick one. Themes aren't versioned: editing one restyles live surveys.
 * WCAG AA contrast is enforced here, not only in the editor.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SaveThemeRequest, type Theme } from '@survey/contracts';
import { checkThemeContrast, FILE_CATEGORY_MIME } from '@survey/core';
import { files, newId, surveys, themes, withTenant, type Tx } from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireOrg } from '../auth/context';
import { AppError, notFound, unprocessable } from '../lib/errors';
import { parse } from '../lib/validate';
import { detectMime } from './respondent';

const LOGO_LIMIT_BYTES = 1024 * 1024;

async function listThemes(tx: Tx, orgId: string): Promise<Theme[]> {
  const rows = await tx.db.select().from(themes).where(eq(themes.orgId, orgId)).orderBy(asc(themes.name));
  const counts = await tx.db
    .select({ themeId: surveys.themeId, n: sql<number>`count(*)::int` })
    .from(surveys)
    .where(sql`${surveys.themeId} is not null and ${surveys.deletedAt} is null`)
    .groupBy(surveys.themeId);
  const logos = await tx.db.select({ id: files.id, status: files.scanStatus }).from(files).where(eq(files.purpose, 'logo'));
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    tokens: t.tokens,
    logoFileId: t.logoFileId,
    logoUrl: t.logoFileId && logos.find((l) => l.id === t.logoFileId)?.status === 'clean' ? `/r/v1/assets/${t.logoFileId}` : null,
    isDefault: t.isDefault,
    surveyCount: counts.find((c) => c.themeId === t.id)?.n ?? 0,
    updatedAt: t.updatedAt.toISOString(),
  }));
}

function assertContrast(tokens: Parameters<typeof checkThemeContrast>[0]) {
  const problems = checkThemeContrast(tokens);
  if (problems.length)
    throw unprocessable(
      'contrast_too_low',
      'Some colours are too hard to read. Adjust them to meet WCAG AA contrast.',
      problems.map((p) => ({ path: `tokens.${p.pair}`, code: 'contrast_too_low', message: p.message })),
    );
}

export function registerThemeRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;

  app.get('/api/v1/themes', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, (tx) => listThemes(tx, auth.orgId));
  });

  app.post('/api/v1/themes', async (req, reply) => {
    const auth = requireOrg(req, 'org.update');
    const body = parse(SaveThemeRequest, req.body);
    assertContrast(body.tokens);
    const id = newId();
    const list = await withTenant(pool, auth.orgId, async (tx) => {
      if (body.isDefault) await tx.db.update(themes).set({ isDefault: false }).where(eq(themes.orgId, auth.orgId));
      await tx.db.insert(themes).values({
        id,
        orgId: auth.orgId,
        name: body.name,
        tokens: body.tokens,
        logoFileId: body.logoFileId ?? null,
        isDefault: body.isDefault ?? false,
        createdBy: auth.userId,
      });
      await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'theme.created', entityType: 'theme', entityId: id, ip: req.ip });
      return listThemes(tx, auth.orgId);
    });
    reply.code(201);
    return list.find((t) => t.id === id)!;
  });

  app.put<{ Params: { id: string } }>('/api/v1/themes/:id', async (req) => {
    const auth = requireOrg(req, 'org.update');
    const body = parse(SaveThemeRequest, req.body);
    assertContrast(body.tokens);
    return withTenant(pool, auth.orgId, async (tx) => {
      if (body.isDefault)
        await tx.db.update(themes).set({ isDefault: false }).where(and(eq(themes.orgId, auth.orgId), ne(themes.id, req.params.id)));
      const [row] = await tx.db
        .update(themes)
        .set({
          name: body.name,
          tokens: body.tokens,
          ...(body.logoFileId !== undefined ? { logoFileId: body.logoFileId } : {}),
          ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
          updatedAt: new Date(),
        })
        .where(eq(themes.id, req.params.id))
        .returning({ id: themes.id });
      if (!row) throw notFound('Theme');
      await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'theme.updated', entityType: 'theme', entityId: row.id, ip: req.ip });
      return (await listThemes(tx, auth.orgId)).find((t) => t.id === row.id)!;
    });
  });

  app.delete<{ Params: { id: string } }>('/api/v1/themes/:id', async (req, reply) => {
    const auth = requireOrg(req, 'org.update');
    await withTenant(pool, auth.orgId, async (tx) => {
      const [row] = await tx.db.delete(themes).where(eq(themes.id, req.params.id)).returning({ id: themes.id });
      if (!row) throw notFound('Theme');
      await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'theme.deleted', entityType: 'theme', entityId: row.id, ip: req.ip });
    });
    return reply.code(204).send();
  });

  /** Upload a logo (PNG, JPEG, WebP or GIF, at most 1 MB). It's served once its scan is clean. */
  app.post('/api/v1/themes/logo', async (req, reply) => {
    const auth = requireOrg(req, 'org.update');
    const part = await req.file({ limits: { fileSize: LOGO_LIMIT_BYTES, files: 1 } });
    if (!part) throw unprocessable('no_file', 'Choose an image to upload.');
    const buffer = await part.toBuffer().catch((error: { code?: string }) => {
      if (error.code === 'FST_REQ_FILE_TOO_LARGE') throw new AppError(413, 'file_too_large', 'Logos can be at most 1 MB.');
      throw error;
    });
    const mime = await detectMime(buffer, part.filename);
    if (!mime || !FILE_CATEGORY_MIME.image.includes(mime))
      throw unprocessable('file_type_not_allowed', 'Use a PNG, JPEG, WebP or GIF image. SVG is not accepted.');
    const fileId = newId();
    const storageKey = `logos/${auth.orgId}/${fileId}`;
    await deps.storage.put(storageKey, buffer, mime);
    await withTenant(pool, auth.orgId, async (tx) => {
      await tx.db.insert(files).values({
        id: fileId,
        orgId: auth.orgId,
        purpose: 'logo',
        storageKey,
        filename: part.filename.replace(/[\\/\0\r\n]/g, '_').slice(0, 200) || 'logo',
        mime,
        size: buffer.length,
        sha256: createHash('sha256').update(buffer).digest(),
      });
      await deps.jobs.enqueue(tx, 'files.scan', { orgId: auth.orgId, fileId });
    });
    reply.code(201);
    return { fileId, url: `/r/v1/assets/${fileId}` };
  });
}
