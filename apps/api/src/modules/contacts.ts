/**
 * Contacts, lists and CSV imports (Phase 2B). Contacts are personal data: only org admins and
 * creators manage them (analysts never see them), every change is tenant-scoped by RLS, and deletes
 * are hard deletes. Unsubscribed and bounced contacts stay flagged however they're re-imported.
 */
import { and, desc, eq, ilike, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  ColumnMappingSchema,
  ContactsQuery,
  ImportFieldsSchema,
  ListMembersRequest,
  SaveContactRequest,
  SaveListRequest,
  type Contact,
  type ContactImport,
  type ContactList,
  type ContactStatus,
} from '@survey/contracts';
import { contactImports, contactListMembers, contactLists, contacts, newId, withTenant, type Tx } from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireOrg } from '../auth/context';
import { AppError, conflict, notFound, unprocessable } from '../lib/errors';
import { decodeCursor, encodeCursor, iso } from '../lib/misc';
import { parse } from '../lib/validate';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMPORT_LIMIT_BYTES = 20 * 1024 * 1024;

type ContactRow = typeof contacts.$inferSelect;

export function contactStatus(c: Pick<ContactRow, 'unsubscribedAt' | 'bouncedAt' | 'complainedAt'>): ContactStatus {
  if (c.bouncedAt) return 'bounced';
  if (c.unsubscribedAt || c.complainedAt) return 'unsubscribed';
  return 'subscribed';
}

async function withLists(tx: Tx, rows: ContactRow[]): Promise<Contact[]> {
  const memberships = rows.length
    ? await tx.db
        .select({ contactId: contactListMembers.contactId, id: contactLists.id, name: contactLists.name })
        .from(contactListMembers)
        .innerJoin(contactLists, eq(contactLists.id, contactListMembers.listId))
        .where(inArray(contactListMembers.contactId, rows.map((r) => r.id)))
    : [];
  return rows.map((c) => ({
    id: c.id,
    email: c.email,
    firstName: c.firstName,
    lastName: c.lastName,
    attributes: c.attributes,
    status: contactStatus(c),
    lists: memberships.filter((m) => m.contactId === c.id).map((m) => ({ id: m.id, name: m.name })),
    createdAt: c.createdAt.toISOString(),
  }));
}

function toImport(row: typeof contactImports.$inferSelect): ContactImport {
  return {
    id: row.id,
    status: row.status,
    filename: row.filename,
    listId: row.listId,
    total: row.total,
    created: row.created,
    updated: row.updated,
    skipped: row.skipped,
    errors: row.errors,
    errorReportUrl: row.errorReportKey ? `/api/v1/contacts/imports/${row.id}/errors.csv` : null,
    failure: row.failure,
    createdAt: row.createdAt.toISOString(),
    finishedAt: iso(row.finishedAt),
  };
}

async function setListMembers(tx: Tx, orgId: string, contactId: string, listIds: string[]) {
  await tx.db.delete(contactListMembers).where(eq(contactListMembers.contactId, contactId));
  if (!listIds.length) return;
  const lists = await tx.db.select({ id: contactLists.id }).from(contactLists).where(inArray(contactLists.id, listIds));
  if (lists.length !== new Set(listIds).size) throw unprocessable('invalid_list', "One of the lists doesn't exist.");
  await tx.db.insert(contactListMembers).values(lists.map((l) => ({ orgId, listId: l.id, contactId })));
}

const escapeLike = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

export function registerContactRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;

  // ── Contacts ────────────────────────────────────────────────────────────
  app.get('/api/v1/contacts', async (req) => {
    const auth = requireOrg(req, 'contacts.manage');
    const query = parse(ContactsQuery, req.query);
    const cursor = decodeCursor(query.cursor, 2);
    return withTenant(pool, auth.orgId, async (tx) => {
      const conditions: (SQL | undefined)[] = [];
      if (query.q) {
        const like = `%${escapeLike(query.q)}%`;
        conditions.push(or(ilike(contacts.email, like), ilike(contacts.firstName, like), ilike(contacts.lastName, like)));
      }
      if (query.listId)
        conditions.push(
          sql`exists (select 1 from contact_list_members m where m.contact_id = ${contacts.id} and m.list_id = ${query.listId})`,
        );
      if (query.status === 'bounced') conditions.push(isNotNull(contacts.bouncedAt));
      if (query.status === 'unsubscribed')
        conditions.push(and(isNull(contacts.bouncedAt), or(isNotNull(contacts.unsubscribedAt), isNotNull(contacts.complainedAt))));
      if (query.status === 'subscribed')
        conditions.push(and(isNull(contacts.bouncedAt), isNull(contacts.unsubscribedAt), isNull(contacts.complainedAt)));
      if (cursor)
        conditions.push(
          or(
            lt(contacts.createdAt, new Date(String(cursor[0]))),
            and(eq(contacts.createdAt, new Date(String(cursor[0]))), lt(contacts.id, String(cursor[1]))),
          ),
        );
      const rows = await tx.db
        .select()
        .from(contacts)
        .where(and(...conditions))
        .orderBy(desc(contacts.createdAt), desc(contacts.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        data: await withLists(tx, page),
        nextCursor: rows.length > query.limit && last ? encodeCursor([last.createdAt.toISOString(), last.id]) : null,
      };
    });
  });

  /** Attribute names in use, for merge tags in campaign emails. */
  app.get('/api/v1/contacts/attributes', async (req) => {
    const auth = requireOrg(req, 'contacts.manage');
    return withTenant(pool, auth.orgId, async (tx) => {
      const { rows } = await tx.client.query<{ key: string }>(
        `select distinct jsonb_object_keys(attributes) as key from contacts order by 1 limit 100`,
      );
      return rows.map((r) => r.key);
    });
  });

  app.post('/api/v1/contacts', async (req, reply) => {
    const auth = requireOrg(req, 'contacts.manage');
    const body = parse(SaveContactRequest, req.body);
    const contact = await withTenant(pool, auth.orgId, async (tx) => {
      const [existing] = await tx.db.select({ id: contacts.id }).from(contacts).where(eq(contacts.email, body.email));
      if (existing) throw conflict('contact_exists', 'A contact with this email already exists.', { contactId: existing.id });
      const id = newId();
      const [row] = await tx.db
        .insert(contacts)
        .values({
          id,
          orgId: auth.orgId,
          email: body.email.toLowerCase(),
          firstName: body.firstName ?? null,
          lastName: body.lastName ?? null,
          attributes: body.attributes ?? {},
        })
        .returning();
      if (body.listIds) await setListMembers(tx, auth.orgId, id, body.listIds);
      await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'contact.created', entityType: 'contact', entityId: id, ip: req.ip });
      return (await withLists(tx, [row!]))[0]!;
    });
    reply.code(201);
    return contact;
  });

  app.patch<{ Params: { id: string } }>('/api/v1/contacts/:id', async (req) => {
    const auth = requireOrg(req, 'contacts.manage');
    if (!UUID.test(req.params.id)) throw notFound('Contact');
    const body = parse(SaveContactRequest.partial(), req.body);
    return withTenant(pool, auth.orgId, async (tx) => {
      const [current] = await tx.db.select().from(contacts).where(eq(contacts.id, req.params.id));
      if (!current) throw notFound('Contact');
      if (body.email && body.email.toLowerCase() !== current.email.toLowerCase()) {
        const [taken] = await tx.db.select({ id: contacts.id }).from(contacts).where(eq(contacts.email, body.email));
        if (taken) throw conflict('contact_exists', 'A contact with this email already exists.', { contactId: taken.id });
      }
      const [row] = await tx.db
        .update(contacts)
        .set({
          ...(body.email ? { email: body.email.toLowerCase() } : {}),
          ...(body.firstName !== undefined ? { firstName: body.firstName } : {}),
          ...(body.lastName !== undefined ? { lastName: body.lastName } : {}),
          ...(body.attributes ? { attributes: body.attributes } : {}),
          updatedAt: new Date(),
        })
        .where(eq(contacts.id, current.id))
        .returning();
      if (body.listIds) await setListMembers(tx, auth.orgId, current.id, body.listIds);
      await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'contact.updated', entityType: 'contact', entityId: current.id, ip: req.ip });
      return (await withLists(tx, [row!]))[0]!;
    });
  });

  app.delete<{ Params: { id: string } }>('/api/v1/contacts/:id', async (req, reply) => {
    const auth = requireOrg(req, 'contacts.manage');
    if (!UUID.test(req.params.id)) throw notFound('Contact');
    await withTenant(pool, auth.orgId, async (tx) => {
      const [row] = await tx.db.delete(contacts).where(eq(contacts.id, req.params.id)).returning({ id: contacts.id });
      if (!row) throw notFound('Contact');
      // No email in the audit entry: the contact is gone on purpose (erasure).
      await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'contact.deleted', entityType: 'contact', entityId: row.id, ip: req.ip });
    });
    return reply.code(204).send();
  });

  // ── Lists ───────────────────────────────────────────────────────────────
  async function listLists(tx: Tx): Promise<ContactList[]> {
    const { rows } = await tx.client.query<{ id: string; name: string; created_at: Date; members: number }>(
      `select l.id, l.name, l.created_at, (select count(*)::int from contact_list_members m where m.list_id = l.id) as members
         from contact_lists l order by lower(l.name)`,
    );
    return rows.map((r) => ({ id: r.id, name: r.name, memberCount: r.members, createdAt: r.created_at.toISOString() }));
  }

  app.get('/api/v1/contact-lists', async (req) => {
    const auth = requireOrg(req, 'contacts.manage');
    return withTenant(pool, auth.orgId, listLists);
  });

  app.post('/api/v1/contact-lists', async (req, reply) => {
    const auth = requireOrg(req, 'contacts.manage');
    const { name } = parse(SaveListRequest, req.body);
    const id = newId();
    const list = await withTenant(pool, auth.orgId, async (tx) => {
      const [taken] = await tx.db.select({ id: contactLists.id }).from(contactLists).where(sql`lower(${contactLists.name}) = lower(${name})`);
      if (taken) throw conflict('list_exists', 'A list with this name already exists.');
      await tx.db.insert(contactLists).values({ id, orgId: auth.orgId, name, createdBy: auth.userId });
      return (await listLists(tx)).find((l) => l.id === id)!;
    });
    reply.code(201);
    return list;
  });

  app.patch<{ Params: { id: string } }>('/api/v1/contact-lists/:id', async (req) => {
    const auth = requireOrg(req, 'contacts.manage');
    const { name } = parse(SaveListRequest, req.body);
    if (!UUID.test(req.params.id)) throw notFound('List');
    return withTenant(pool, auth.orgId, async (tx) => {
      const [row] = await tx.db.update(contactLists).set({ name }).where(eq(contactLists.id, req.params.id)).returning({ id: contactLists.id });
      if (!row) throw notFound('List');
      return (await listLists(tx)).find((l) => l.id === row.id)!;
    });
  });

  app.delete<{ Params: { id: string } }>('/api/v1/contact-lists/:id', async (req, reply) => {
    const auth = requireOrg(req, 'contacts.manage');
    if (!UUID.test(req.params.id)) throw notFound('List');
    await withTenant(pool, auth.orgId, async (tx) => {
      const [row] = await tx.db.delete(contactLists).where(eq(contactLists.id, req.params.id)).returning({ id: contactLists.id });
      if (!row) throw notFound('List');
    });
    return reply.code(204).send();
  });

  for (const action of ['add', 'remove'] as const) {
    app.post<{ Params: { id: string } }>(`/api/v1/contact-lists/:id/members${action === 'remove' ? '/remove' : ''}`, async (req) => {
      const auth = requireOrg(req, 'contacts.manage');
      const { contactIds } = parse(ListMembersRequest, req.body);
      if (!UUID.test(req.params.id)) throw notFound('List');
      return withTenant(pool, auth.orgId, async (tx) => {
        const [list] = await tx.db.select({ id: contactLists.id }).from(contactLists).where(eq(contactLists.id, req.params.id));
        if (!list) throw notFound('List');
        if (action === 'add') {
          const found = await tx.db.select({ id: contacts.id }).from(contacts).where(inArray(contacts.id, contactIds));
          if (found.length)
            await tx.db
              .insert(contactListMembers)
              .values(found.map((c) => ({ orgId: auth.orgId, listId: list.id, contactId: c.id })))
              .onConflictDoNothing();
        } else {
          await tx.db
            .delete(contactListMembers)
            .where(and(eq(contactListMembers.listId, list.id), inArray(contactListMembers.contactId, contactIds)));
        }
        return (await listLists(tx)).find((l) => l.id === list.id)!;
      });
    });
  }

  // ── CSV imports ─────────────────────────────────────────────────────────
  app.post('/api/v1/contacts/imports', async (req, reply) => {
    const auth = requireOrg(req, 'contacts.manage');
    const part = await req.file({ limits: { fileSize: IMPORT_LIMIT_BYTES, files: 1 } });
    if (!part) throw unprocessable('no_file', 'Choose a CSV file to import.');
    const field = (name: string) => {
      const f = part.fields[name];
      return f && !Array.isArray(f) && f.type === 'field' ? String(f.value) : undefined;
    };
    const fields = parse(ImportFieldsSchema, { mapping: field('mapping'), listId: field('listId') || undefined, newListName: field('newListName') || undefined });
    let mappingJson: unknown;
    try {
      mappingJson = JSON.parse(fields.mapping);
    } catch {
      throw unprocessable('invalid_mapping', 'The column mapping is malformed.');
    }
    const mapping = parse(ColumnMappingSchema, mappingJson);
    const buffer = await part.toBuffer().catch((error: { code?: string }) => {
      if (error.code === 'FST_REQ_FILE_TOO_LARGE') throw new AppError(413, 'file_too_large', 'Import files can be at most 20 MB.');
      throw error;
    });
    if (buffer.length === 0) throw unprocessable('empty_file', 'That file is empty.');
    if (buffer.includes(0)) throw unprocessable('file_type_not_allowed', "That doesn't look like a CSV file.");

    const id = newId();
    const storageKey = `imports/${auth.orgId}/${id}.csv`;
    await deps.storage.put(storageKey, buffer, 'text/csv');
    const row = await withTenant(pool, auth.orgId, async (tx) => {
      let listId = fields.listId ?? null;
      if (listId) {
        const [list] = await tx.db.select({ id: contactLists.id }).from(contactLists).where(eq(contactLists.id, listId));
        if (!list) throw unprocessable('invalid_list', "That list doesn't exist.");
      } else if (fields.newListName) {
        const [existing] = await tx.db
          .select({ id: contactLists.id })
          .from(contactLists)
          .where(sql`lower(${contactLists.name}) = lower(${fields.newListName})`);
        listId = existing?.id ?? newId();
        if (!existing) await tx.db.insert(contactLists).values({ id: listId, orgId: auth.orgId, name: fields.newListName, createdBy: auth.userId });
      }
      const [created] = await tx.db
        .insert(contactImports)
        .values({
          id,
          orgId: auth.orgId,
          listId,
          storageKey,
          filename: part.filename.replace(/[\\/\0\r\n]/g, '_').slice(0, 200) || 'contacts.csv',
          columnMapping: mapping,
          createdBy: auth.userId,
        })
        .returning();
      await deps.jobs.enqueue(tx, 'contacts.import', { orgId: auth.orgId, importId: id });
      await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'contacts.import_started', entityType: 'contact_import', entityId: id, ip: req.ip });
      return created!;
    });
    reply.code(202);
    return toImport(row);
  });

  app.get('/api/v1/contacts/imports', async (req) => {
    const auth = requireOrg(req, 'contacts.manage');
    return withTenant(pool, auth.orgId, async (tx) =>
      (await tx.db.select().from(contactImports).orderBy(desc(contactImports.createdAt)).limit(20)).map(toImport),
    );
  });

  app.get<{ Params: { id: string } }>('/api/v1/contacts/imports/:id', async (req) => {
    const auth = requireOrg(req, 'contacts.manage');
    if (!UUID.test(req.params.id)) throw notFound('Import');
    return withTenant(pool, auth.orgId, async (tx) => {
      const [row] = await tx.db.select().from(contactImports).where(eq(contactImports.id, req.params.id));
      if (!row) throw notFound('Import');
      return toImport(row);
    });
  });

  app.get<{ Params: { id: string } }>('/api/v1/contacts/imports/:id/errors.csv', async (req, reply) => {
    const auth = requireOrg(req, 'contacts.manage');
    if (!UUID.test(req.params.id)) throw notFound('Import');
    const row = await withTenant(pool, auth.orgId, async (tx) => (await tx.db.select().from(contactImports).where(eq(contactImports.id, req.params.id)))[0]);
    if (!row?.errorReportKey) throw notFound('Error report');
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="import-errors-${row.id.slice(0, 8)}.csv"`)
      .header('cache-control', 'no-store');
    return reply.send(await deps.storage.stream(row.errorReportKey));
  });
}
