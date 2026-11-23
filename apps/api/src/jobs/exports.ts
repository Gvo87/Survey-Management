/**
 * Export and scheduled-report jobs (Phase 2B).
 *
 * - exports.generate: builds CSV, XLSX or PDF in the worker, stores it for 7 days.
 * - exports.cleanup: deletes expired files.
 * - reports.tick (every 5 minutes): runs due scheduled reports and emails them to their recipients
 *   (org members who can see the survey's responses), as an attachment when small enough.
 */
import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import { and, eq, inArray } from 'drizzle-orm';
import type { ExportFormat, ExportOptions } from '@survey/contracts';
import { dataExports, memberships, newId, organizations, scheduledReports, surveyCollaborators, surveys, users, withGlobal, withTenant } from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { effectiveSurveyRole, surveyCan } from '../auth/permissions';
import { csvCell, csvRow, UTF8_BOM } from '../lib/csv';
import { slugify } from '../lib/misc';
import { renderPdfReport } from '../lib/pdf-report';
import { nextRun } from '../lib/time';
import { exportRows } from '../modules/export-data';
import { computeSummary } from '../modules/results';

type SurveyRow = typeof surveys.$inferSelect;
const KEEP_DAYS = 7;
const ATTACH_LIMIT = 8 * 1024 * 1024;

const CONTENT_TYPE: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

/** XLSX cells get the CSV protection too (a leading apostrophe on formula-like text), so both match. */
function xlsxCell(value: unknown): string | number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = csvCell(value);
  // csvCell may also quote for CSV; undo that for XLSX.
  return text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1).replace(/""/g, '"') : text;
}

export async function buildExportFile(deps: Deps, orgId: string, survey: SurveyRow, format: ExportFormat, options: Partial<ExportOptions>) {
  const settings = { layout: options.layout ?? 'compact', includeTest: options.includeTest ?? false, ...options } as const;
  const base = `${slugify(survey.title) || 'survey'}-${new Date().toISOString().slice(0, 10)}`;

  if (format === 'pdf') {
    const { summary, orgName } = await withTenant(deps.pool, orgId, async (tx) => {
      await tx.client.query(`set local statement_timeout = '60s'`);
      const [org] = await tx.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
      return {
        orgName: org?.name ?? '',
        summary: await computeSummary(tx, survey, {
          from: settings.from,
          to: settings.to,
          versionId: settings.versionId,
          includePartial: settings.status === 'all',
          includeTest: settings.includeTest,
          excludeFlagged: settings.excludeFlagged ?? false,
          filter: settings.filter,
        }),
      };
    });
    const scope = [
      settings.status === 'all' ? 'All responses, including partial ones' : 'Completed responses',
      settings.from || settings.to ? `started ${settings.from?.slice(0, 10) ?? '...'} to ${settings.to?.slice(0, 10) ?? '...'}` : null,
      settings.filter ? 'filtered' : null,
      settings.excludeFlagged ? 'low-quality responses left out' : null,
    ]
      .filter(Boolean)
      .join(', ');
    const buffer = await renderPdfReport({ title: survey.title, orgName, scope, generatedAt: new Date() }, summary);
    return { buffer, filename: `${base}-report.pdf`, rowCount: summary.totals.completed };
  }

  let rowCount = -1; // minus the header row
  if (format === 'csv') {
    const parts: string[] = [UTF8_BOM];
    for await (const rows of exportRows(deps.pool, orgId, survey, settings)) {
      for (const row of rows) parts.push(csvRow(row));
      rowCount += rows.length;
    }
    return { buffer: Buffer.from(parts.join(''), 'utf8'), filename: `${base}-responses.csv`, rowCount };
  }

  // XLSX, streamed row by row so 50k responses don't build a workbook in memory.
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useSharedStrings: false, useStyles: true });
  const sheet = workbook.addWorksheet('Responses', { views: [{ state: 'frozen', ySplit: 1 }] });
  let header = true;
  for await (const rows of exportRows(deps.pool, orgId, survey, settings)) {
    for (const row of rows) {
      const added = sheet.addRow(row.map(xlsxCell));
      if (header) {
        added.font = { bold: true };
        sheet.columns.forEach((c) => (c.width = 18));
        header = false;
      }
      added.commit();
      rowCount++;
    }
  }
  sheet.commit();
  await workbook.commit();
  return { buffer: Buffer.concat(chunks), filename: `${base}-responses.xlsx`, rowCount };
}

export function exportJobs(deps: Deps) {
  const { pool, storage } = deps;

  async function generate(orgId: string, exportId: string) {
    const loaded = await withTenant(pool, orgId, async (tx) => {
      const [row] = await tx.db.select().from(dataExports).where(eq(dataExports.id, exportId));
      if (!row || row.status !== 'queued') return null;
      const [survey] = await tx.db.select().from(surveys).where(eq(surveys.id, row.surveyId));
      if (!survey) return null;
      await tx.db.update(dataExports).set({ status: 'running' }).where(eq(dataExports.id, exportId));
      return { row, survey };
    });
    if (!loaded) return null;
    try {
      const file = await buildExportFile(deps, orgId, loaded.survey, loaded.row.format, loaded.row.options as Partial<ExportOptions>);
      const storageKey = `exports/${orgId}/${exportId}.${loaded.row.format}`;
      await storage.put(storageKey, file.buffer, CONTENT_TYPE[loaded.row.format]);
      await withTenant(pool, orgId, (tx) =>
        tx.db
          .update(dataExports)
          .set({
            status: 'done',
            storageKey,
            filename: file.filename,
            size: file.buffer.length,
            rowCount: file.rowCount,
            finishedAt: new Date(),
            expiresAt: new Date(Date.now() + KEEP_DAYS * 86_400_000),
          })
          .where(eq(dataExports.id, exportId)),
      );
      return { ...file, contentType: CONTENT_TYPE[loaded.row.format] };
    } catch (error) {
      await withTenant(pool, orgId, (tx) =>
        tx.db
          .update(dataExports)
          .set({ status: 'failed', failure: (error instanceof Error ? error.message : 'Export failed').slice(0, 500), finishedAt: new Date() })
          .where(eq(dataExports.id, exportId)),
      );
      throw error;
    }
  }

  return {
    'exports.generate': async ({ orgId, exportId }: { orgId: string; exportId: string }) => {
      await generate(orgId, exportId);
    },

    'exports.cleanup': async () => {
      const { rows } = await withGlobal(pool, (tx) =>
        tx.client.query<{ org_id: string; export_id: string; storage_key: string }>('select * from expired_exports($1)', [new Date()]),
      );
      for (const row of rows) {
        await storage.delete(row.storage_key).catch(() => {});
        await withTenant(pool, row.org_id, (tx) => tx.db.update(dataExports).set({ storageKey: null }).where(eq(dataExports.id, row.export_id)));
      }
    },

    'reports.tick': async () => {
      const { rows: due } = await withGlobal(pool, (tx) =>
        tx.client.query<{ org_id: string; report_id: string }>('select * from due_scheduled_reports($1)', [new Date()]),
      );
      for (const { org_id: orgId, report_id: reportId } of due) {
        // Claim the run by moving next_run_at first, so a retried tick never sends twice.
        const claimed = await withTenant(pool, orgId, async (tx) => {
          const [report] = await tx.db.select().from(scheduledReports).where(eq(scheduledReports.id, reportId)).for('update');
          if (!report || !report.active || report.nextRunAt.getTime() > Date.now()) return null;
          const [survey] = await tx.db.select().from(surveys).where(eq(surveys.id, report.surveyId));
          await tx.db
            .update(scheduledReports)
            .set({ nextRunAt: nextRun(report, new Date()), lastRunAt: new Date(), lastStatus: 'running' })
            .where(eq(scheduledReports.id, report.id));
          if (!survey || survey.deletedAt) return null;
          // Recipients are re-checked on every run: people who left the org or lost access get nothing.
          const people = report.recipientIds.length
            ? await tx.db
                .select({ id: users.id, email: users.email, name: users.name, role: memberships.role, shared: surveyCollaborators.role })
                .from(users)
                .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.orgId, orgId)))
                .leftJoin(surveyCollaborators, and(eq(surveyCollaborators.userId, users.id), eq(surveyCollaborators.surveyId, survey.id)))
                .where(inArray(users.id, report.recipientIds))
            : [];
          const allowed = people.filter((p) => {
            const role = effectiveSurveyRole(p.role, p.shared ?? null);
            return role && surveyCan(role, 'responses.view');
          });
          const exportId = newId();
          await tx.db.insert(dataExports).values({ id: exportId, orgId, surveyId: survey.id, format: report.format, options: report.options });
          await audit(tx, { orgId, actorId: null, action: 'report.generated', entityType: 'scheduled_report', entityId: report.id, metadata: { recipients: allowed.length } });
          return { report, survey, exportId, recipients: [...new Map(allowed.map((p) => [p.id, p])).values()] };
        });
        if (!claimed) continue;
        let status = 'sent';
        try {
          const file = await generate(orgId, claimed.exportId);
          if (file) {
            const link = `${deps.config.appUrl}/surveys/${claimed.survey.id}/results?export=${claimed.exportId}`;
            for (const person of claimed.recipients)
              await deps.mailer.send({
                to: person.email,
                subject: `Report: ${claimed.survey.title} (${claimed.report.name})`.slice(0, 200),
                text: `Hi ${person.name},\n\nHere is your scheduled ${claimed.report.format.toUpperCase()} report for "${claimed.survey.title}" (${file.rowCount} responses).\n\n${
                  file.buffer.length <= ATTACH_LIMIT ? 'It is attached.' : `It is too large to attach. Download it (for ${KEEP_DAYS} days): ${link}`
                }\n\nManage this report in the survey's Results tab.\n`,
                ...(file.buffer.length <= ATTACH_LIMIT ? { attachments: [{ filename: file.filename, content: file.buffer, contentType: file.contentType }] } : {}),
              });
          }
        } catch {
          status = 'failed';
        }
        await withTenant(pool, orgId, (tx) =>
          tx.db.update(scheduledReports).set({ lastStatus: status }).where(eq(scheduledReports.id, claimed.report.id)),
        );
      }
    },
  };
}
