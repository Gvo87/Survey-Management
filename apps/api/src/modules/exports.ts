/**
 * Asynchronous exports (CSV, XLSX, PDF) and scheduled reports (Phase 2B). Every export is audited;
 * files are kept for 7 days and downloaded through the API (permission re-checked, audited).
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { CreateExportRequest, SaveScheduledReportRequest, type ExportJob, type ScheduledReport } from '@survey/contracts';
import { dataExports, memberships, newId, scheduledReports, surveyCollaborators, users, withTenant, type Tx } from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireOrg } from '../auth/context';
import { effectiveSurveyRole, surveyCan } from '../auth/permissions';
import { gone, notFound, unprocessable } from '../lib/errors';
import { iso } from '../lib/misc';
import { isValidTimeZone, nextRun } from '../lib/time';
import { parse } from '../lib/validate';
import { loadSurvey, strongerRole, teamRoleOfUsersSql } from './surveys';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type ExportRow = typeof dataExports.$inferSelect;
type ReportRow = typeof scheduledReports.$inferSelect;

function toJob(row: ExportRow): ExportJob {
  return {
    id: row.id,
    format: row.format,
    status: row.status,
    filename: row.filename,
    size: row.size,
    rowCount: row.rowCount,
    downloadUrl: row.status === 'done' && row.storageKey ? `/api/v1/exports/${row.id}/download` : null,
    failure: row.failure,
    createdAt: row.createdAt.toISOString(),
    finishedAt: iso(row.finishedAt),
    expiresAt: iso(row.expiresAt),
  };
}

async function toReports(tx: Tx, rows: ReportRow[]): Promise<ScheduledReport[]> {
  const ids = [...new Set(rows.flatMap((r) => r.recipientIds))];
  const people = ids.length ? await tx.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids)) : [];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    frequency: r.frequency,
    day: r.day,
    hour: r.hour,
    timezone: r.timezone,
    format: r.format,
    options: r.options as ScheduledReport['options'],
    recipients: r.recipientIds.map((id) => people.find((p) => p.id === id)).filter((p): p is { id: string; name: string; email: string } => Boolean(p)),
    active: r.active,
    nextRunAt: r.nextRunAt.toISOString(),
    lastRunAt: iso(r.lastRunAt),
    lastStatus: r.lastStatus,
  }));
}

export function registerExportRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;

  async function loadExport(tx: Tx, auth: Parameters<typeof loadSurvey>[1], id: string) {
    if (!UUID.test(id)) throw notFound('Export');
    const [row] = await tx.db.select().from(dataExports).where(eq(dataExports.id, id));
    if (!row) throw notFound('Export');
    await loadSurvey(tx, auth, row.surveyId, 'responses.export');
    return row;
  }

  app.post<{ Params: { id: string } }>('/api/v1/surveys/:id/exports', async (req, reply) => {
    const auth = requireOrg(req);
    const { format, ...options } = parse(CreateExportRequest, req.body);
    const job = await withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.export');
      const id = newId();
      const [row] = await tx.db.insert(dataExports).values({ id, orgId: auth.orgId, surveyId: survey.id, requestedBy: auth.userId, format, options }).returning();
      await deps.jobs.enqueue(tx, 'exports.generate', { orgId: auth.orgId, exportId: id });
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'responses.exported',
        entityType: 'survey',
        entityId: survey.id,
        metadata: { format, exportId: id, ...options },
        ip: req.ip,
      });
      return toJob(row!);
    });
    reply.code(202);
    return job;
  });

  app.get<{ Params: { id: string } }>('/api/v1/surveys/:id/exports', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.export');
      const rows = await tx.db.select().from(dataExports).where(eq(dataExports.surveyId, survey.id)).orderBy(desc(dataExports.createdAt)).limit(10);
      return rows.map(toJob);
    });
  });

  app.get<{ Params: { id: string } }>('/api/v1/exports/:id', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => toJob(await loadExport(tx, auth, req.params.id)));
  });

  app.get<{ Params: { id: string } }>('/api/v1/exports/:id/download', async (req, reply) => {
    const auth = requireOrg(req);
    const row = await withTenant(pool, auth.orgId, async (tx) => {
      const found = await loadExport(tx, auth, req.params.id);
      if (found.status !== 'done') throw notFound('Export');
      if (!found.storageKey) throw gone('export_expired', 'This export has expired. Create a new one.');
      await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'export.downloaded', entityType: 'export', entityId: found.id, ip: req.ip });
      return found;
    });
    const type = { csv: 'text/csv; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' }[row.format];
    const filename = row.filename ?? `export.${row.format}`;
    reply
      .header('content-type', type)
      .header('content-disposition', `attachment; filename="${filename.replace(/[^\x20-\x7e]|"/g, '_')}"`)
      .header('cache-control', 'no-store');
    return reply.send(await deps.storage.stream(row.storageKey!));
  });

  // ── Scheduled reports ───────────────────────────────────────────────────
  async function checkRecipients(tx: Tx, orgId: string, surveyId: string, ids: string[]) {
    const rows = await tx.db
      .select({ id: users.id, role: memberships.role, shared: surveyCollaborators.role, teamRole: teamRoleOfUsersSql(surveyId) })
      .from(users)
      .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.orgId, orgId)))
      .leftJoin(surveyCollaborators, and(eq(surveyCollaborators.userId, users.id), eq(surveyCollaborators.surveyId, surveyId)))
      .where(inArray(users.id, ids));
    for (const id of new Set(ids)) {
      const row = rows.find((r) => r.id === id);
      const role = row ? effectiveSurveyRole(row.role, strongerRole(row.shared ?? null, row.teamRole)) : null;
      if (!role || !surveyCan(role, 'responses.view'))
        throw unprocessable('invalid_recipient', 'Reports can only go to members of your organization who can see this survey’s responses.');
    }
  }

  app.get<{ Params: { id: string } }>('/api/v1/surveys/:id/scheduled-reports', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.export');
      return toReports(tx, await tx.db.select().from(scheduledReports).where(eq(scheduledReports.surveyId, survey.id)).orderBy(scheduledReports.createdAt));
    });
  });

  app.post<{ Params: { id: string } }>('/api/v1/surveys/:id/scheduled-reports', async (req, reply) => {
    const auth = requireOrg(req);
    const body = parse(SaveScheduledReportRequest, req.body);
    if (!isValidTimeZone(body.timezone)) throw unprocessable('invalid_timezone', 'Choose a valid time zone.');
    const report = await withTenant(pool, auth.orgId, async (tx) => {
      const { survey } = await loadSurvey(tx, auth, req.params.id, 'responses.export');
      await checkRecipients(tx, auth.orgId, survey.id, body.recipientIds);
      const id = newId();
      const [row] = await tx.db
        .insert(scheduledReports)
        .values({
          id,
          orgId: auth.orgId,
          surveyId: survey.id,
          name: body.name,
          frequency: body.frequency,
          day: body.frequency === 'daily' ? null : body.day,
          hour: body.hour,
          timezone: body.timezone,
          format: body.format,
          options: body.options,
          recipientIds: [...new Set(body.recipientIds)],
          active: body.active,
          nextRunAt: nextRun({ ...body, day: body.frequency === 'daily' ? null : body.day }, new Date()),
          createdBy: auth.userId,
        })
        .returning();
      await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'report.scheduled', entityType: 'scheduled_report', entityId: id, ip: req.ip });
      return (await toReports(tx, [row!]))[0]!;
    });
    reply.code(201);
    return report;
  });

  app.put<{ Params: { id: string } }>('/api/v1/scheduled-reports/:id', async (req) => {
    const auth = requireOrg(req);
    const body = parse(SaveScheduledReportRequest, req.body);
    if (!isValidTimeZone(body.timezone)) throw unprocessable('invalid_timezone', 'Choose a valid time zone.');
    if (!UUID.test(req.params.id)) throw notFound('Report');
    return withTenant(pool, auth.orgId, async (tx) => {
      const [current] = await tx.db.select().from(scheduledReports).where(eq(scheduledReports.id, req.params.id));
      if (!current) throw notFound('Report');
      const { survey } = await loadSurvey(tx, auth, current.surveyId, 'responses.export');
      await checkRecipients(tx, auth.orgId, survey.id, body.recipientIds);
      const day = body.frequency === 'daily' ? null : body.day;
      const [row] = await tx.db
        .update(scheduledReports)
        .set({
          name: body.name,
          frequency: body.frequency,
          day,
          hour: body.hour,
          timezone: body.timezone,
          format: body.format,
          options: body.options,
          recipientIds: [...new Set(body.recipientIds)],
          active: body.active,
          nextRunAt: nextRun({ ...body, day }, new Date()),
        })
        .where(eq(scheduledReports.id, current.id))
        .returning();
      return (await toReports(tx, [row!]))[0]!;
    });
  });

  app.delete<{ Params: { id: string } }>('/api/v1/scheduled-reports/:id', async (req, reply) => {
    const auth = requireOrg(req);
    if (!UUID.test(req.params.id)) throw notFound('Report');
    await withTenant(pool, auth.orgId, async (tx) => {
      const [current] = await tx.db.select().from(scheduledReports).where(eq(scheduledReports.id, req.params.id));
      if (!current) throw notFound('Report');
      await loadSurvey(tx, auth, current.surveyId, 'responses.export');
      await tx.db.delete(scheduledReports).where(eq(scheduledReports.id, current.id));
      await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'report.deleted', entityType: 'scheduled_report', entityId: current.id, ip: req.ip });
    });
    return reply.code(204).send();
  });
}
