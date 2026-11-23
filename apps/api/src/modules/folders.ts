/**
 * Survey folders (Phase 3A): an org-wide tree, at most three levels deep. Everyone sees the tree;
 * the survey counts only include surveys the caller can see. Admins and creators organise it.
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SaveFolderRequest, type Folder } from '@survey/contracts';
import { folders, newId, surveys, withTenant, type Tx } from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireOrg } from '../auth/context';
import type { OrgAuth } from '../auth/session';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { parse } from '../lib/validate';
import { isUniqueViolation } from './auth';

export const MAX_FOLDER_DEPTH = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type FolderRow = typeof folders.$inferSelect;

/** Every folder of the org, locked so concurrent moves can't build a cycle or a fourth level. */
async function lockedTree(tx: Tx): Promise<FolderRow[]> {
  return tx.db.select().from(folders).for('update');
}

function depthOf(tree: FolderRow[], id: string | null): number {
  let depth = 0;
  for (let current = id; current && depth <= MAX_FOLDER_DEPTH + 1; depth++)
    current = tree.find((f) => f.id === current)?.parentId ?? null;
  return depth;
}

/** Levels in the subtree rooted at `id`, the folder itself included. */
function heightOf(tree: FolderRow[], id: string): number {
  const children = tree.filter((f) => f.parentId === id);
  return 1 + Math.max(0, ...children.map((c) => heightOf(tree, c.id)));
}

function isInside(tree: FolderRow[], id: string | null, ancestor: string): boolean {
  for (let current = id; current; current = tree.find((f) => f.id === current)?.parentId ?? null)
    if (current === ancestor) return true;
  return false;
}

async function visibleCounts(tx: Tx, auth: OrgAuth): Promise<Map<string, number>> {
  const { rows } = await tx.client.query<{ folder_id: string; n: number }>(
    `select s.folder_id, count(*)::int as n from surveys s
      where s.folder_id is not null and s.deleted_at is null and not s.is_template
        and ($1 or exists (select 1 from survey_collaborators sc where sc.survey_id = s.id and sc.user_id = $2)
                or exists (select 1 from survey_team_collaborators stc join team_members tm on tm.team_id = stc.team_id
                            where stc.survey_id = s.id and tm.user_id = $2))
      group by s.folder_id`,
    [auth.orgRole === 'org_admin', auth.userId],
  );
  return new Map(rows.map((r) => [r.folder_id, r.n]));
}

function toFolders(tree: FolderRow[], counts: Map<string, number>): Folder[] {
  return tree
    .map((f) => ({
      id: f.id,
      name: f.name,
      parentId: f.parentId,
      depth: depthOf(tree, f.id),
      surveyCount: counts.get(f.id) ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function registerFolderRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;
  type IdParams = { Params: { id: string } };

  app.get('/api/v1/folders', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) =>
      toFolders(await tx.db.select().from(folders), await visibleCounts(tx, auth)),
    );
  });

  app.post('/api/v1/folders', async (req, reply) => {
    const auth = requireOrg(req, 'surveys.create');
    const body = parse(SaveFolderRequest, req.body);
    const folder = await withTenant(pool, auth.orgId, async (tx) => {
      const tree = await lockedTree(tx);
      const parentId = body.parentId ?? null;
      if (parentId && !tree.some((f) => f.id === parentId))
        throw unprocessable('invalid_parent', "That folder doesn't exist.");
      if (depthOf(tree, parentId) + 1 > MAX_FOLDER_DEPTH)
        throw unprocessable('too_deep', `Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep.`);
      const id = newId();
      try {
        await tx.db
          .insert(folders)
          .values({ id, orgId: auth.orgId, parentId, name: body.name, createdBy: auth.userId });
      } catch (error) {
        if (isUniqueViolation(error))
          throw conflict('folder_exists', 'A folder with that name is already here.');
        throw error;
      }
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'folder.created',
        entityType: 'folder',
        entityId: id,
        ip: req.ip,
      });
      const all = await tx.db.select().from(folders);
      return toFolders(all, await visibleCounts(tx, auth)).find((f) => f.id === id)!;
    });
    reply.code(201);
    return folder;
  });

  app.patch<IdParams>('/api/v1/folders/:id', async (req) => {
    const auth = requireOrg(req, 'surveys.create');
    const body = parse(SaveFolderRequest.partial(), req.body);
    if (!UUID.test(req.params.id)) throw notFound('Folder');
    return withTenant(pool, auth.orgId, async (tx) => {
      const tree = await lockedTree(tx);
      const folder = tree.find((f) => f.id === req.params.id);
      if (!folder) throw notFound('Folder');
      const parentId = body.parentId === undefined ? folder.parentId : body.parentId;
      if (parentId !== folder.parentId) {
        if (parentId && !tree.some((f) => f.id === parentId))
          throw unprocessable('invalid_parent', "That folder doesn't exist.");
        if (isInside(tree, parentId, folder.id))
          throw unprocessable(
            'invalid_parent',
            "A folder can't be moved into itself or one of its subfolders.",
          );
        if (depthOf(tree, parentId) + heightOf(tree, folder.id) > MAX_FOLDER_DEPTH)
          throw unprocessable('too_deep', `Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep.`);
      }
      try {
        await tx.db
          .update(folders)
          .set({ name: body.name ?? folder.name, parentId })
          .where(eq(folders.id, folder.id));
      } catch (error) {
        if (isUniqueViolation(error))
          throw conflict('folder_exists', 'A folder with that name is already here.');
        throw error;
      }
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: parentId !== folder.parentId ? 'folder.moved' : 'folder.renamed',
        entityType: 'folder',
        entityId: folder.id,
        ip: req.ip,
      });
      const all = await tx.db.select().from(folders);
      return toFolders(all, await visibleCounts(tx, auth)).find((f) => f.id === folder.id)!;
    });
  });

  /** Deleting a folder moves its subfolders and surveys up to its parent; nothing else is deleted. */
  app.delete<IdParams>('/api/v1/folders/:id', async (req, reply) => {
    const auth = requireOrg(req, 'surveys.create');
    if (!UUID.test(req.params.id)) throw notFound('Folder');
    await withTenant(pool, auth.orgId, async (tx) => {
      const tree = await lockedTree(tx);
      const folder = tree.find((f) => f.id === req.params.id);
      if (!folder) throw notFound('Folder');
      const siblings = new Set(
        tree
          .filter((f) => f.parentId === folder.parentId && f.id !== folder.id)
          .map((f) => f.name.toLowerCase()),
      );
      for (const child of tree.filter((f) => f.parentId === folder.id)) {
        // Keep names unique among the new siblings.
        let name = child.name;
        for (let n = 2; siblings.has(name.toLowerCase()); n++) name = `${child.name} (${n})`;
        siblings.add(name.toLowerCase());
        await tx.db.update(folders).set({ parentId: folder.parentId, name }).where(eq(folders.id, child.id));
      }
      await tx.db.update(surveys).set({ folderId: folder.parentId }).where(eq(surveys.folderId, folder.id));
      await tx.db.delete(folders).where(eq(folders.id, folder.id));
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'folder.deleted',
        entityType: 'folder',
        entityId: folder.id,
        metadata: { name: folder.name },
        ip: req.ip,
      });
    });
    return reply.code(204).send();
  });
}
