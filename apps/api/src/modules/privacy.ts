/**
 * Privacy requests (Phase 3B, GDPR/CCPA): an org admin exports or erases everything this org holds about one
 * email address. It runs as a job in the org's tenant context and covers:
 *
 * - contacts with that email, their list memberships and campaign recipients (sends, reminders);
 * - responses linked to the person: through a campaign link, a signed-in member (login-required surveys),
 *   an answer equal to the email (e.g. an email question) or a hidden field equal to it;
 * - those responses' answers, uploaded files, tags and notes, and AI summaries that cite them.
 *
 * Anonymous surveys are out of scope by design: nothing links their responses to a person. A member's
 * account isn't deleted here (members are removed in member management); the export includes it.
 * Audit entries record counts, never the address.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { CreatePrivacyRequest, type PrivacyRequest } from '@survey/contracts';
import { displayAnswer, plainTitle } from '@survey/core';
import {
  campaigns,
  contacts,
  memberships,
  newId,
  organizations,
  privacyRequests,
  recipients,
  responses,
  surveys,
  surveyVersions,
  users,
  withTenant,
  type Tx,
} from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireOrg } from '../auth/context';
import { gone, notFound, unprocessable } from '../lib/errors';
import { iso } from '../lib/misc';
import { deleteSurveyResponses } from '../lib/response-deletion';
import { parse } from '../lib/validate';
import { contentDisposition } from './files';
import { answerValues, loadCells } from './results';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPORT_TTL_MS = 7 * 24 * 3600 * 1000;
type RequestRow = typeof privacyRequests.$inferSelect;

function toRequest(row: RequestRow, requestedBy: string | null): PrivacyRequest {
  return {
    id: row.id,
    kind: row.kind,
    subjectEmail: row.subjectEmail,
    status: row.status,
    result: row.result,
    requestedBy,
    createdAt: row.createdAt.toISOString(),
    completedAt: iso(row.completedAt),
    downloadUrl: row.kind === 'export' && row.status === 'done' && row.storageKey ? `/api/v1/privacy/requests/${row.id}/download` : null,
    failure: row.failure,
  };
}

export function registerPrivacyRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;

  const withNames = async (tx: Tx, rows: RequestRow[]) => {
    const ids = [...new Set(rows.map((r) => r.requestedBy).filter((id): id is string => Boolean(id)))];
    const people = ids.length ? await tx.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];
    return rows.map((r) => toRequest(r, people.find((p) => p.id === r.requestedBy)?.name ?? null));
  };

  app.get('/api/v1/privacy/requests', async (req) => {
    const auth = requireOrg(req, 'org.members.manage');
    return withTenant(pool, auth.orgId, async (tx) => {
      const rows = await tx.db.select().from(privacyRequests).orderBy(desc(privacyRequests.createdAt)).limit(100);
      return { data: await withNames(tx, rows) };
    });
  });

  app.post('/api/v1/privacy/requests', async (req, reply) => {
    const auth = requireOrg(req, 'org.members.manage');
    const body = parse(CreatePrivacyRequest, req.body);
    if (body.kind === 'erase' && body.confirmEmail !== body.subjectEmail)
      throw unprocessable('confirmation_mismatch', 'Type the email address again to confirm the erasure.', [
        { path: 'confirmEmail', code: 'mismatch', message: "This doesn't match the address above." },
      ]);
    const created = await withTenant(pool, auth.orgId, async (tx) => {
      const [row] = await tx.db
        .insert(privacyRequests)
        .values({ id: newId(), orgId: auth.orgId, kind: body.kind, subjectEmail: body.subjectEmail, requestedBy: auth.userId })
        .returning();
      await deps.jobs.enqueue(tx, 'privacy.process', { orgId: auth.orgId, requestId: row!.id });
      // The address itself stays out of the append-only audit log, so an erasure can really erase it.
      await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: `privacy.${body.kind}_requested`, entityType: 'privacy_request', entityId: row!.id, ip: req.ip });
      return toRequest(row!, auth.name);
    });
    reply.code(202);
    return created;
  });

  app.get<{ Params: { id: string } }>('/api/v1/privacy/requests/:id', async (req) => {
    const auth = requireOrg(req, 'org.members.manage');
    if (!UUID.test(req.params.id)) throw notFound('Request');
    return withTenant(pool, auth.orgId, async (tx) => {
      const [row] = await tx.db.select().from(privacyRequests).where(eq(privacyRequests.id, req.params.id));
      if (!row) throw notFound('Request');
      return (await withNames(tx, [row]))[0];
    });
  });

  app.get<{ Params: { id: string } }>('/api/v1/privacy/requests/:id/download', async (req, reply) => {
    const auth = requireOrg(req, 'org.members.manage');
    if (!UUID.test(req.params.id)) throw notFound('Request');
    const row = await withTenant(pool, auth.orgId, async (tx) => {
      const [found] = await tx.db.select().from(privacyRequests).where(eq(privacyRequests.id, req.params.id));
      if (!found || found.kind !== 'export' || found.status !== 'done') throw notFound('Export');
      if (!found.storageKey) throw gone('export_expired', 'This export has expired. Request a new one.');
      await audit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'privacy.export_downloaded', entityType: 'privacy_request', entityId: found.id, ip: req.ip });
      return found;
    });
    reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', contentDisposition(row.filename ?? 'subject-export.json'))
      .header('cache-control', 'no-store');
    return reply.send(await deps.storage.stream(row.storageKey!));
  });
}

interface FoundResponse {
  id: string;
  survey_id: string;
  reason: string;
}

/** Everything linked to the address (non-anonymous surveys only). */
async function findRecords(tx: Tx, email: string) {
  const contactRows = await tx.db.select().from(contacts).where(eq(contacts.email, email));
  const contactIds = contactRows.map((c) => c.id);
  const recipientRows = contactIds.length
    ? await tx.db
        .select({ r: recipients, campaign: campaigns.name, surveyTitle: surveys.title })
        .from(recipients)
        .innerJoin(campaigns, eq(campaigns.id, recipients.campaignId))
        .innerJoin(surveys, eq(surveys.id, campaigns.surveyId))
        .where(inArray(recipients.contactId, contactIds))
    : [];
  const [user] = await tx.db.select().from(users).where(eq(users.email, email));
  const [member] = user
    ? await tx.db.select().from(memberships).where(and(eq(memberships.userId, user.id), sql`${memberships.orgId} = app_org_id()`))
    : [];
  const { rows: found } = await tx.client.query<FoundResponse>(
    `select r.id, r.survey_id,
            case when r.recipient_id = any($2::uuid[]) then 'campaign_link'
                 when r.respondent_user_id = $3::uuid then 'signed_in'
                 when exists (select 1 from jsonb_each_text(r.hidden_fields) h where lower(h.value) = lower($1)) then 'hidden_field'
                 else 'answer' end as reason
       from responses r join surveys s on s.id = r.survey_id
      where not s.anonymous
        and (r.recipient_id = any($2::uuid[])
             or ($3::uuid is not null and r.respondent_user_id = $3::uuid)
             or exists (select 1 from answers a where a.response_id = r.id and lower(a.value_text) = lower($1))
             or exists (select 1 from jsonb_each_text(r.hidden_fields) h where lower(h.value) = lower($1)))`,
    [email, recipientRows.map((x) => x.r.id), user?.id ?? null],
  );
  const { rows: anonymous } = await tx.client.query<{ n: number }>(`select count(*)::int as n from surveys where anonymous and deleted_at is null`);
  return { contactRows, recipientRows, user, member, found, anonymousSurveys: anonymous[0]!.n };
}

/** The worker: build the export file, or erase. */
export async function processPrivacyRequest(deps: Deps, orgId: string, requestId: string): Promise<void> {
  const fail = (message: string) =>
    withTenant(deps.pool, orgId, (tx) =>
      tx.db.update(privacyRequests).set({ status: 'failed', failure: message.slice(0, 500), completedAt: new Date() }).where(eq(privacyRequests.id, requestId)),
    );
  try {
    await withTenant(deps.pool, orgId, async (tx) => {
      const [request] = await tx.db.select().from(privacyRequests).where(eq(privacyRequests.id, requestId)).for('update');
      if (!request || request.status !== 'pending') return;
      const email = request.subjectEmail.toLowerCase();
      const records = await findRecords(tx, email);
      const responseIds = records.found.map((r) => r.id);
      const { rows: fileCount } = await tx.client.query<{ n: number }>('select count(*)::int as n from files where response_id = any($1::uuid[])', [responseIds]);
      const counts = {
        contacts: records.contactRows.length,
        campaignMessages: records.recipientRows.length,
        responses: responseIds.length,
        files: fileCount[0]!.n,
        anonymousSurveysNotSearched: records.anonymousSurveys,
      };

      if (request.kind === 'export') {
        const document = await buildExport(tx, orgId, email, records);
        const body = Buffer.from(JSON.stringify(document, null, 2), 'utf8');
        const storageKey = `privacy/${orgId}/${request.id}.json`;
        await deps.storage.put(storageKey, body, 'application/json');
        await tx.db
          .update(privacyRequests)
          .set({
            status: 'done',
            result: counts,
            storageKey,
            filename: `subject-export-${new Date().toISOString().slice(0, 10)}.json`,
            size: body.length,
            expiresAt: new Date(Date.now() + EXPORT_TTL_MS),
            completedAt: new Date(),
          })
          .where(eq(privacyRequests.id, request.id));
        await audit(tx, { orgId, actorId: null, action: 'privacy.exported', entityType: 'privacy_request', entityId: request.id, metadata: counts });
        return;
      }

      // Erasure. AI summaries citing the responses go first (they may quote them).
      const { rowCount: summaries } = await tx.client.query(
        `delete from text_insights t
          where exists (select 1 from jsonb_array_elements(t.themes) theme, jsonb_array_elements_text(theme->'responseIds') cited(rid)
                         where cited.rid = any($1::text[]))`,
        [responseIds],
      );
      const bySurvey = new Map<string, string[]>();
      for (const r of records.found) bySurvey.set(r.survey_id, [...(bySurvey.get(r.survey_id) ?? []), r.id]);
      for (const [surveyId, ids] of bySurvey) await deleteSurveyResponses(deps, tx, surveyId, ids);
      // Contacts cascade to list memberships and campaign recipients.
      if (records.contactRows.length) await tx.db.delete(contacts).where(inArray(contacts.id, records.contactRows.map((c) => c.id)));
      const result = { ...counts, aiSummaries: summaries ?? 0 };
      await tx.db.update(privacyRequests).set({ status: 'done', result, completedAt: new Date() }).where(eq(privacyRequests.id, request.id));
      await audit(tx, { orgId, actorId: null, action: 'privacy.erased', entityType: 'privacy_request', entityId: request.id, metadata: result });
    });
  } catch (error) {
    await fail((error as Error).message || 'The request failed.');
    throw error;
  }
}

async function buildExport(tx: Tx, orgId: string, email: string, records: Awaited<ReturnType<typeof findRecords>>) {
  const [org] = await tx.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
  const surveyIds = [...new Set(records.found.map((r) => r.survey_id))];
  const responseRows = records.found.length
    ? await tx.db
        .select({ r: responses, surveyTitle: surveys.title, definition: surveyVersions.definition })
        .from(responses)
        .innerJoin(surveys, eq(surveys.id, responses.surveyId))
        .innerJoin(surveyVersions, eq(surveyVersions.id, responses.versionId))
        .where(inArray(responses.id, records.found.map((r) => r.id)))
    : [];
  const cellsBySurvey = new Map<string, Awaited<ReturnType<typeof loadCells>>>();
  for (const surveyId of surveyIds)
    cellsBySurvey.set(surveyId, await loadCells(tx, surveyId, records.found.filter((f) => f.survey_id === surveyId).map((f) => f.id)));
  const { rows: fileRows } = await tx.client.query<{ response_id: string; filename: string; size: number; mime: string; created_at: Date }>(
    'select response_id, filename, size, mime, created_at from files where response_id = any($1::uuid[])',
    [records.found.map((r) => r.id)],
  );
  const { rows: noteRows } = await tx.client.query<{ response_id: string; body: string; created_at: Date }>(
    'select response_id, body, created_at from response_notes where response_id = any($1::uuid[]) order by created_at',
    [records.found.map((r) => r.id)],
  );
  return {
    subject: email,
    organization: org?.name ?? null,
    generatedAt: new Date().toISOString(),
    scope:
      'Everything this organization holds that is linked to this email address. Responses to anonymous surveys are not linked to anyone, so they cannot be found or included.',
    member: records.member && records.user
      ? { name: records.user.name, email: records.user.email, role: records.member.role, joinedAt: records.member.createdAt.toISOString() }
      : null,
    contacts: records.contactRows.map((c) => ({
      email: c.email,
      firstName: c.firstName,
      lastName: c.lastName,
      attributes: c.attributes,
      createdAt: c.createdAt.toISOString(),
      unsubscribedAt: iso(c.unsubscribedAt),
      bouncedAt: iso(c.bouncedAt),
      complainedAt: iso(c.complainedAt),
    })),
    campaignMessages: records.recipientRows.map(({ r, campaign, surveyTitle }) => ({
      campaign,
      survey: surveyTitle,
      status: r.status,
      sentAt: iso(r.sentAt),
      remindersSent: r.remindersSent,
      respondedAt: iso(r.respondedAt),
    })),
    responses: responseRows.map(({ r, surveyTitle, definition }) => ({
      survey: surveyTitle,
      responseId: r.id,
      linkedBy: records.found.find((f) => f.id === r.id)?.reason,
      status: r.status,
      language: r.locale,
      startedAt: r.startedAt.toISOString(),
      completedAt: iso(r.completedAt),
      device: r.deviceType,
      hiddenFields: r.hiddenFields,
      answers: answerValues(definition, cellsBySurvey.get(r.surveyId)?.get(r.id) ?? []).map(({ question, value }) => ({
        question: plainTitle(question),
        answer: displayAnswer(question, value),
      })),
      files: fileRows.filter((f) => f.response_id === r.id).map((f) => ({ filename: f.filename, size: f.size, type: f.mime, uploadedAt: f.created_at.toISOString() })),
      notes: noteRows.filter((n) => n.response_id === r.id).map((n) => ({ note: n.body, createdAt: n.created_at.toISOString() })),
    })),
  };
}
