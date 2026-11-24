/**
 * Translations (Phase 3B). Strings live per language next to the definition in
 * `survey_versions.translations` and are edited on the draft or on a published version: changing text
 * can't change structure or keys, so this is a deliberate, audited exception to immutable versions
 * (risks C8). New drafts start with the live version's translations.
 *
 * CSV import and export use `key, context, source, translation` columns, so translators can work in a
 * spreadsheet. Exported cells starting with = + - @ get a leading apostrophe (formula injection); import
 * strips it again.
 */
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { parse as parseCsvSync } from 'csv-parse/sync';
import {
  ImportTranslationCsvRequest,
  LocaleParam,
  SaveTranslationRequest,
  type ImportTranslationResult,
  type TranslationDetail,
  type TranslationsOverview,
} from '@survey/contracts';
import { checkTranslation, cleanTranslation, MAX_LANGUAGES, textDirection, translatableStrings } from '@survey/core';
import { surveyVersions, withTenant, type Tx } from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireOrg } from '../auth/context';
import type { OrgAuth } from '../auth/session';
import { csvRow, UTF8_BOM } from '../lib/csv';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { parse } from '../lib/validate';
import { contentDisposition } from './files';
import { loadSurvey } from './surveys';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Params = { Params: { id: string; versionId: string; locale?: string } };
type VersionRow = typeof surveyVersions.$inferSelect;

/** The respondent API caches a version's translations; editing them drops the cache. */
export const translationsCacheKey = (versionId: string) => `tr:v1:${versionId}`;

export function registerTranslationRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;

  async function loadVersion(tx: Tx, auth: OrgAuth, surveyId: string, versionId: string, edit: boolean, lock = false) {
    const { survey } = await loadSurvey(tx, auth, surveyId, edit ? 'survey.edit' : 'survey.view');
    if (!UUID.test(versionId)) throw notFound('Version');
    const query = tx.db
      .select()
      .from(surveyVersions)
      .where(and(eq(surveyVersions.id, versionId), eq(surveyVersions.surveyId, survey.id)));
    const [version] = lock ? await query.for('update') : await query;
    if (!version) throw notFound('Version');
    return { survey, version };
  }

  function localeOf(raw: string | undefined, version: VersionRow): string {
    const result = LocaleParam.safeParse(raw);
    if (!result.success) throw unprocessable('invalid_locale', 'Use a language code like fr or pt-BR.');
    if (result.data === version.definition.defaultLocale)
      throw unprocessable('default_locale', 'That is the survey’s own language. Edit its text in the builder.');
    return result.data;
  }

  const detail = (version: VersionRow, title: string, locale: string): TranslationDetail => {
    const strings = version.translations[locale] ?? {};
    const check = checkTranslation(version.definition, strings, title);
    return { locale, dir: textDirection(locale), strings, missing: check.missing, tokenMismatches: check.tokenMismatches };
  };

  /** Replace one language's strings, audit it and drop the respondent cache. */
  async function store(tx: Tx, auth: OrgAuth, ip: string, version: VersionRow, surveyId: string, locale: string, strings: Record<string, string>, action: string, extra: Record<string, unknown> = {}) {
    const isNew = !(locale in version.translations);
    if (isNew && Object.keys(version.translations).length >= MAX_LANGUAGES)
      throw conflict('too_many_languages', `A survey can have at most ${MAX_LANGUAGES} languages.`);
    const translations = { ...version.translations, [locale]: strings };
    const [saved] = await tx.db
      .update(surveyVersions)
      .set({ translations, updatedAt: new Date() })
      .where(eq(surveyVersions.id, version.id))
      .returning();
    await audit(tx, {
      orgId: auth.orgId,
      actorId: auth.userId,
      action,
      entityType: 'survey',
      entityId: surveyId,
      metadata: { locale, versionNumber: version.versionNumber, published: version.status === 'published', strings: Object.keys(strings).length, ...extra },
      ip,
    });
    await deps.redis.del(translationsCacheKey(version.id)).catch(() => {});
    return saved!;
  }

  app.get<Params>('/api/v1/surveys/:id/versions/:versionId/translations', async (req): Promise<TranslationsOverview> => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey, version } = await loadVersion(tx, auth, req.params.id, req.params.versionId, false);
      return {
        versionId: version.id,
        versionNumber: version.versionNumber,
        status: version.status,
        defaultLocale: version.definition.defaultLocale,
        languages: Object.keys(version.translations)
          .sort()
          .map((locale) => {
            const check = checkTranslation(version.definition, version.translations[locale]!, survey.title);
            return {
              locale,
              dir: textDirection(locale),
              total: check.total,
              translated: check.translated,
              missing: check.missing.length,
              tokenMismatches: check.tokenMismatches.length,
            };
          }),
        strings: translatableStrings(version.definition, survey.title),
      };
    });
  });

  app.get<Params>('/api/v1/surveys/:id/versions/:versionId/translations/:locale', async (req): Promise<TranslationDetail> => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey, version } = await loadVersion(tx, auth, req.params.id, req.params.versionId, false);
      const locale = localeOf(req.params.locale, version);
      if (!(locale in version.translations)) throw notFound('Language');
      return detail(version, survey.title, locale);
    });
  });

  app.put<Params>('/api/v1/surveys/:id/versions/:versionId/translations/:locale', async (req): Promise<TranslationDetail> => {
    const auth = requireOrg(req);
    const { strings } = parse(SaveTranslationRequest, req.body);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey, version } = await loadVersion(tx, auth, req.params.id, req.params.versionId, true, true);
      const locale = localeOf(req.params.locale, version);
      const saved = await store(tx, auth, req.ip, version, survey.id, locale, cleanTranslation(version.definition, strings, survey.title), 'survey.translation_saved');
      return detail(saved, survey.title, locale);
    });
  });

  app.delete<Params>('/api/v1/surveys/:id/versions/:versionId/translations/:locale', async (req, reply) => {
    const auth = requireOrg(req);
    await withTenant(pool, auth.orgId, async (tx) => {
      const { survey, version } = await loadVersion(tx, auth, req.params.id, req.params.versionId, true, true);
      const locale = localeOf(req.params.locale, version);
      if (!(locale in version.translations)) throw notFound('Language');
      const { [locale]: _removed, ...rest } = version.translations;
      await tx.db.update(surveyVersions).set({ translations: rest, updatedAt: new Date() }).where(eq(surveyVersions.id, version.id));
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'survey.translation_removed',
        entityType: 'survey',
        entityId: survey.id,
        metadata: { locale, versionNumber: version.versionNumber, published: version.status === 'published' },
        ip: req.ip,
      });
      await deps.redis.del(translationsCacheKey(version.id)).catch(() => {});
    });
    return reply.code(204).send();
  });

  app.get<Params>('/api/v1/surveys/:id/versions/:versionId/translations/:locale/export.csv', async (req, reply) => {
    const auth = requireOrg(req);
    const { survey, version, locale } = await withTenant(pool, auth.orgId, async (tx) => {
      const loaded = await loadVersion(tx, auth, req.params.id, req.params.versionId, false);
      return { ...loaded, locale: localeOf(req.params.locale, loaded.version) };
    });
    const strings = version.translations[locale] ?? {};
    let csv = UTF8_BOM + csvRow(['key', 'context', 'source', 'translation']);
    for (const s of translatableStrings(version.definition, survey.title)) csv += csvRow([s.key, s.context, s.source, strings[s.key] ?? '']);
    const filename = `${survey.title.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 60) || 'survey'} - ${locale}.csv`;
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', contentDisposition(filename)).send(csv);
  });

  app.post<Params>('/api/v1/surveys/:id/versions/:versionId/translations/:locale/import', async (req): Promise<ImportTranslationResult> => {
    const auth = requireOrg(req);
    const { csv } = parse(ImportTranslationCsvRequest, req.body);
    const rows = parseTranslationCsv(csv);
    return withTenant(pool, auth.orgId, async (tx) => {
      const { survey, version } = await loadVersion(tx, auth, req.params.id, req.params.versionId, true, true);
      const locale = localeOf(req.params.locale, version);
      const known = new Set(translatableStrings(version.definition, survey.title).map((s) => s.key));
      const unknownKeys = rows.filter((r) => !known.has(r.key)).map((r) => r.key);
      const imported = Object.fromEntries(rows.filter((r) => known.has(r.key) && r.translation.trim()).map((r) => [r.key, r.translation]));
      // Rows with an empty translation keep what's there; the CSV only adds and replaces.
      const merged = cleanTranslation(version.definition, { ...(version.translations[locale] ?? {}), ...imported }, survey.title);
      const saved = await store(tx, auth, req.ip, version, survey.id, locale, merged, 'survey.translation_imported', { imported: Object.keys(imported).length });
      return { imported: Object.keys(imported).length, unknownKeys: unknownKeys.slice(0, 100), translation: detail(saved, survey.title, locale) };
    });
  });
}

/** Rows of a translation CSV, by header name (any column order; extra columns ignored). */
export function parseTranslationCsv(csv: string): { key: string; translation: string }[] {
  let records: string[][];
  try {
    records = parseCsvSync(csv, { relax_column_count: true, skip_empty_lines: true, bom: true }) as string[][];
  } catch (error) {
    throw unprocessable('invalid_csv', `The file isn't valid CSV: ${(error as Error).message.slice(0, 200)}`);
  }
  const header = (records[0] ?? []).map((h) => h.trim().toLowerCase());
  const keyCol = header.indexOf('key');
  const translationCol = header.indexOf('translation');
  if (keyCol < 0 || translationCol < 0) throw unprocessable('invalid_csv', 'The first row must name the columns, including "key" and "translation".');
  if (records.length > 5001) throw unprocessable('invalid_csv', 'The file has more than 5,000 rows.');
  return records.slice(1).flatMap((row) => {
    const key = row[keyCol]?.trim();
    if (!key) return [];
    // Undo the export's formula protection: a leading apostrophe before = + - @.
    const raw = row[translationCol] ?? '';
    return [{ key, translation: /^'[=+\-@\t\r]/.test(raw) ? raw.slice(1) : raw }];
  });
}
