/**
 * Contact CSV import (Phase 2B). Streams the file, validates each row, merges duplicates by email
 * (inside the file and with existing contacts), upserts in batches of 1,000 and writes an error report.
 * Unsubscribe and bounce flags are never cleared by an import.
 */
import { Readable } from 'node:stream';
import { parse as parseCsv } from 'csv-parse';
import { eq } from 'drizzle-orm';
import { contactImports, newId, withTenant, type ColumnMapping } from '@survey/db';
import type { Deps } from '../deps';
import { csvRow, UTF8_BOM } from '../lib/csv';

const BATCH = 1000;
const MAX_ROWS = 200_000;
const MAX_SHOWN_ERRORS = 100;
// Deliberately simple, like the email question type: one @, no spaces, a dot in the domain.
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

interface Pending {
  email: string;
  first_name: string | null;
  last_name: string | null;
  attributes: Record<string, string>;
}

export async function importContacts(deps: Deps, orgId: string, importId: string): Promise<void> {
  const { pool, storage } = deps;
  const [job] = await withTenant(pool, orgId, (tx) => tx.db.select().from(contactImports).where(eq(contactImports.id, importId)));
  if (!job || job.status === 'done' || job.status === 'failed') return;
  await withTenant(pool, orgId, (tx) => tx.db.update(contactImports).set({ status: 'running' }).where(eq(contactImports.id, importId)));

  const mapping: ColumnMapping = job.columnMapping;
  const errors: { row: number; email: string; message: string }[] = [];
  const byEmail = new Map<string, Pending>();
  let total = 0;
  let created = 0;
  let updated = 0;

  try {
    const parser = Readable.from(await storage.get(job.storageKey)).pipe(
      parseCsv({ columns: true, bom: true, skip_empty_lines: true, relax_column_count: true, trim: true, info: true, max_record_size: 100_000 }),
    );
    let checkedHeader = false;
    for await (const { record, info } of parser as AsyncIterable<{ record: Record<string, string>; info: { lines: number } }>) {
      if (!checkedHeader) {
        checkedHeader = true;
        const missing = [mapping.email, mapping.firstName, mapping.lastName, ...Object.keys(mapping.attributes ?? {})].filter(
          (c): c is string => Boolean(c) && !(c! in record),
        );
        if (missing.length) throw new Error(`The file has no column named ${missing.map((m) => `"${m}"`).join(', ')}.`);
      }
      total++;
      if (total > MAX_ROWS) throw new Error(`Files can have at most ${MAX_ROWS.toLocaleString('en')} rows. Split the file and import it in parts.`);
      const email = (record[mapping.email] ?? '').trim().toLowerCase();
      if (!email) {
        errors.push({ row: info.lines, email: '', message: 'Email is missing.' });
        continue;
      }
      if (email.length > 254 || !EMAIL.test(email)) {
        errors.push({ row: info.lines, email, message: 'Email address is not valid.' });
        continue;
      }
      const attributes: Record<string, string> = {};
      for (const [column, name] of Object.entries(mapping.attributes ?? {})) {
        const value = (record[column] ?? '').trim();
        if (value) attributes[name] = value.slice(0, 500);
      }
      const first = (mapping.firstName ? record[mapping.firstName] : '')?.trim().slice(0, 100) || null;
      const last = (mapping.lastName ? record[mapping.lastName] : '')?.trim().slice(0, 100) || null;
      // Duplicates in the file are merged: later non-empty values win.
      const previous = byEmail.get(email);
      byEmail.set(email, {
        email,
        first_name: first ?? previous?.first_name ?? null,
        last_name: last ?? previous?.last_name ?? null,
        attributes: { ...previous?.attributes, ...attributes },
      });
    }

    const rows = [...byEmail.values()];
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH).map((r) => ({ ...r, id: newId() }));
      const result = await withTenant(pool, orgId, async (tx) => {
        const { rows: upserted } = await tx.client.query<{ id: string; inserted: boolean }>(
          `insert into contacts (id, org_id, email, first_name, last_name, attributes)
           select x.id, $2, x.email, x.first_name, x.last_name, coalesce(x.attributes, '{}')
             from jsonb_to_recordset($1::jsonb) as x(id uuid, email citext, first_name text, last_name text, attributes jsonb)
           on conflict (org_id, email) do update set
             first_name = coalesce(excluded.first_name, contacts.first_name),
             last_name = coalesce(excluded.last_name, contacts.last_name),
             attributes = contacts.attributes || excluded.attributes,
             updated_at = now()
           returning id, (xmax = 0) as inserted`,
          [JSON.stringify(batch), orgId],
        );
        if (job.listId)
          await tx.client.query(
            `insert into contact_list_members (org_id, list_id, contact_id)
             select $1, $2, unnest($3::uuid[]) on conflict do nothing`,
            [orgId, job.listId, upserted.map((u) => u.id)],
          );
        const added = upserted.filter((u) => u.inserted).length;
        await tx.db
          .update(contactImports)
          .set({ total, created: created + added, updated: updated + upserted.length - added })
          .where(eq(contactImports.id, importId));
        return { added, merged: upserted.length - added };
      });
      created += result.added;
      updated += result.merged;
    }

    let errorReportKey: string | null = null;
    if (errors.length) {
      errorReportKey = `imports/${orgId}/${importId}-errors.csv`;
      const csv = UTF8_BOM + csvRow(['row', 'email', 'problem']) + errors.map((e) => csvRow([e.row, e.email, e.message])).join('');
      await storage.put(errorReportKey, Buffer.from(csv, 'utf8'), 'text/csv');
    }
    await withTenant(pool, orgId, (tx) =>
      tx.db
        .update(contactImports)
        .set({
          status: 'done',
          total,
          created,
          updated,
          // Invalid rows. Duplicate rows inside the file were merged into one contact.
          skipped: errors.length,
          errors: errors.slice(0, MAX_SHOWN_ERRORS).map(({ row, message }) => ({ row, message })),
          errorReportKey,
          finishedAt: new Date(),
        })
        .where(eq(contactImports.id, importId)),
    );
  } catch (error) {
    const message = error instanceof Error && !/^[A-Z_]+$/.test(error.message) ? error.message : "The file couldn't be read as CSV.";
    await withTenant(pool, orgId, (tx) =>
      tx.db
        .update(contactImports)
        .set({ status: 'failed', total, created, updated, failure: message.slice(0, 500), finishedAt: new Date() })
        .where(eq(contactImports.id, importId)),
    );
  } finally {
    // The uploaded file holds personal data and isn't needed once imported.
    await storage.delete(job.storageKey).catch(() => {});
  }
}
