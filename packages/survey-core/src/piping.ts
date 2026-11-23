/**
 * Piping: insert earlier answers, hidden fields (URL parameters) and contact fields into text.
 *
 *   {{q.q_7Hk2pX}}            an earlier answer, as shown to the respondent (labels, not keys)
 *   {{param.source}}          a hidden field / URL parameter
 *   {{contact.first_name}}    a contact field (Phase 2B; shows the fallback until then)
 *   {{q.q_7Hk2pX|there}}      with a fallback when the value is missing
 *
 * The result is always plain text. Renderers insert it as text, never as HTML, so a respondent
 * typing `<script>` into an answer can't inject markup anywhere it's piped.
 */
import { selectedOptionKeys, otherText, type Answers, type AnswerValue } from './answers';
import type { Question, SurveyDefinition } from './schema';

export const PIPE_TOKEN = /\{\{\s*(q|param|contact)\.([A-Za-z0-9_]+)\s*(?:\|([^}]{0,200}))?\}\}/g;

export interface PipeToken {
  namespace: 'q' | 'param' | 'contact';
  key: string;
  fallback: string;
  raw: string;
}

export interface PipeContext {
  def: SurveyDefinition;
  answers: Answers;
  hidden?: Record<string, string>;
  contact?: Record<string, string>;
}

export function parseTokens(text: string | undefined): PipeToken[] {
  if (!text || !text.includes('{{')) return [];
  return [...text.matchAll(PIPE_TOKEN)].map((m) => ({
    namespace: m[1] as PipeToken['namespace'],
    key: m[2]!,
    fallback: (m[3] ?? '').trim(),
    raw: m[0],
  }));
}

/** `{{…}}` sequences that aren't valid tokens (likely typos). */
export function malformedTokens(text: string | undefined): string[] {
  if (!text) return [];
  const valid = new Set(parseTokens(text).map((t) => t.raw));
  return (text.match(/\{\{[^}]*\}\}/g) ?? []).filter((t) => !valid.has(t));
}

/** How an answer reads inside a sentence. */
export function pipedAnswer(question: Question | undefined, value: AnswerValue | undefined): string {
  if (!question || value === undefined) return '';
  switch (question.type) {
    case 'single_choice':
    case 'dropdown':
    case 'likert':
    case 'multi_choice': {
      const other = otherText(value);
      return selectedOptionKeys(value)
        .map((key) => {
          const option = question.options.find((o) => o.key === key);
          return option?.isOther && other ? other : (option?.label ?? '');
        })
        .filter(Boolean)
        .join(', ');
    }
    case 'ranking':
      return Array.isArray(value)
        ? value.map((key) => question.options.find((o) => o.key === key)?.label ?? '').filter(Boolean).join(', ')
        : '';
    case 'consent':
      return value === true ? 'yes' : '';
    case 'matrix':
    case 'file_upload':
      return '';
    default:
      return typeof value === 'object' ? '' : String(value);
  }
}

function resolve(token: PipeToken, ctx: PipeContext): string {
  let value = '';
  if (token.namespace === 'param') value = ctx.hidden?.[token.key] ?? '';
  else if (token.namespace === 'contact') value = ctx.contact?.[token.key] ?? '';
  else {
    const question = ctx.def.pages.flatMap((p) => p.elements).find((e) => e.kind === 'question' && e.key === token.key);
    value = pipedAnswer(question?.kind === 'question' ? question : undefined, ctx.answers[token.key]);
  }
  return value.trim() || token.fallback;
}

/** Replace tokens in display text. Returns plain text. */
export function pipe(text: string, ctx: PipeContext): string {
  if (!text || !text.includes('{{')) return text;
  return text.replace(PIPE_TOKEN, (...m) => resolve({ namespace: m[1], key: m[2], fallback: (m[3] ?? '').trim(), raw: m[0] }, ctx));
}

/** Replace tokens in a URL, encoding each inserted value. */
export function pipeUrl(url: string, ctx: PipeContext): string {
  if (!url.includes('{{')) return url;
  return url.replace(PIPE_TOKEN, (...m) =>
    encodeURIComponent(resolve({ namespace: m[1], key: m[2], fallback: (m[3] ?? '').trim(), raw: m[0] }, ctx)),
  );
}

/**
 * The redirect after completion: tokens resolved, and (if enabled) hidden fields appended as
 * query parameters. Returns null for anything that isn't an http(s) URL.
 */
export function completionRedirect(ctx: PipeContext): string | null {
  const settings = ctx.def.settings.thankYou;
  if (!settings.redirectUrl) return null;
  try {
    const url = new URL(pipeUrl(settings.redirectUrl, ctx));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (settings.appendHiddenFields) for (const [k, v] of Object.entries(ctx.hidden ?? {})) url.searchParams.set(k, v);
    return url.toString();
  } catch {
    return null;
  }
}
