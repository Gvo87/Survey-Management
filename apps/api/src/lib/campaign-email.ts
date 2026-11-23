/**
 * Campaign links and emails (Phase 2B).
 *
 * Personal link tokens are derived from the recipient id with an HMAC, so they're never stored:
 * the database keeps only sha256(token). Reminders re-derive the same token, so a recipient's link
 * never changes. Rotating SESSION_SECRET therefore invalidates every emailed link.
 */
import { createHmac } from 'node:crypto';
import { sha256 } from '@survey/db';

export function recipientToken(secret: string, recipientId: string): string {
  return createHmac('sha256', secret).update(`recipient:${recipientId}`).digest('base64url').slice(0, 32);
}

export const recipientTokenHash = (secret: string, recipientId: string) => sha256(recipientToken(secret, recipientId));

export const RECIPIENT_TOKEN = /^[A-Za-z0-9_-]{32}$/;

export interface MergeContext {
  contact: { email: string; firstName: string | null; lastName: string | null; attributes: Record<string, string> };
  survey: { title: string; link: string };
  org: { name: string };
}

const TAG = /\{\{\s*(contact|survey)\.([A-Za-z0-9_]+)\s*(?:\|([^}]{0,100}))?\}\}/g;

/** Replace merge tags: {{contact.first_name|there}}, {{contact.<attribute>}}, {{survey.title}}, {{survey.link}}. */
export function mergeTags(text: string, ctx: MergeContext): string {
  return text.replace(TAG, (_, ns: string, key: string, fallback?: string) => {
    let value = '';
    if (ns === 'survey') value = key === 'title' ? ctx.survey.title : key === 'link' ? ctx.survey.link : '';
    else if (key === 'first_name') value = ctx.contact.firstName ?? '';
    else if (key === 'last_name') value = ctx.contact.lastName ?? '';
    else if (key === 'email') value = ctx.contact.email;
    else value = ctx.contact.attributes[key] ?? '';
    return value.trim() || (fallback ?? '').trim();
  });
}

/** Merge tags a campaign may use (for validation and the editor's hints). */
export function unknownMergeTags(text: string, attributes: string[]): string[] {
  const known = new Set(['contact.first_name', 'contact.last_name', 'contact.email', 'survey.title', 'survey.link', ...attributes.map((a) => `contact.${a}`)]);
  return [...text.matchAll(TAG)].map((m) => `${m[1]}.${m[2]}`).filter((t) => !known.has(t));
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderCampaignEmail(
  campaign: { subject: string; body: string },
  ctx: MergeContext,
  links: { unsubscribe: string; oneClickUnsubscribe: string },
  reminder: boolean,
) {
  const subject = `${reminder ? 'Reminder: ' : ''}${mergeTags(campaign.subject, ctx)}`.replace(/[\r\n]+/g, ' ').slice(0, 250);
  let body = mergeTags(campaign.body, ctx);
  // Always include the link, even if the template forgot it.
  if (!campaign.body.includes('{{survey.link') && !campaign.body.includes('{{ survey.link')) body += `\n\n${ctx.survey.link}`;
  const footer = `You're receiving this from ${ctx.org.name}. Unsubscribe: ${links.unsubscribe}`;
  const text = `${body}\n\n--\n${footer}\n`;
  const paragraphs = escapeHtml(body)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px">${p.replace(/\n/g, '<br>').replace(escapeHtml(ctx.survey.link), `<a href="${escapeHtml(ctx.survey.link)}">${escapeHtml(ctx.survey.link)}</a>`)}</p>`)
    .join('');
  const html = `<!doctype html><html><body style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:16px;line-height:1.5;color:#1b1f24;max-width:600px">
${paragraphs}
<p style="margin:24px 0"><a href="${escapeHtml(ctx.survey.link)}" style="background:#2445a8;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Take the survey</a></p>
<p style="margin-top:32px;font-size:13px;color:#555e69">You're receiving this from ${escapeHtml(ctx.org.name)}. <a href="${escapeHtml(links.unsubscribe)}" style="color:#555e69">Unsubscribe</a></p>
</body></html>`;
  return {
    subject,
    text,
    html,
    headers: {
      // RFC 8058 one-click unsubscribe: mail clients POST to this URL.
      'List-Unsubscribe': `<${links.oneClickUnsubscribe}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
