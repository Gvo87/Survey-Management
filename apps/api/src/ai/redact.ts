/**
 * Remove email addresses and phone numbers from answer text before it leaves the platform for the AI
 * provider (roadmap §4.6). Deliberately broad: a false positive costs a word in a summary, a false
 * negative sends personal data to a third party.
 */

const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Obfuscated forms: "name at example dot com", "name [at] example [dot] com".
const EMAIL_SPELLED = /\b[A-Za-z0-9._%+-]+\s*(?:\(at\)|\[at\]|\{at\}|\sat\s)\s*[A-Za-z0-9-]+(?:\s*(?:\(dot\)|\[dot\]|\{dot\}|\sdot\s|\.)\s*[A-Za-z0-9-]+)+\b/gi;
// A run of digits, optionally starting with + or (, with spaces, dots, dashes or brackets between groups:
// at least 7 digits in total. Dates (2026-11-24) and short numbers stay.
const PHONE = /(?:\+|\(|\b)\d[\d\s().-]{5,}\d\b/g;

const digitCount = (s: string) => (s.match(/\d/g) ?? []).length;
const looksLikeDate = (s: string) => /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$|^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(s.trim());

export function redactPersonalData(text: string): { text: string; redactions: number } {
  let redactions = 0;
  let out = text.replace(EMAIL, () => {
    redactions++;
    return '[email]';
  });
  out = out.replace(EMAIL_SPELLED, () => {
    redactions++;
    return '[email]';
  });
  out = out.replace(PHONE, (match) => {
    if (digitCount(match) < 7 || looksLikeDate(match)) return match;
    redactions++;
    return '[phone]';
  });
  return { text: out, redactions };
}
