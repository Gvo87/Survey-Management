/** Phase 3B: language names come from the browser (Intl), so no list of names ships with the app. */
export function languageName(code: string, inLanguage = 'en'): string {
  try {
    return new Intl.DisplayNames([inLanguage], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Offered first when adding a language; any other code can be typed. */
export const COMMON_LANGUAGES = [
  'ar', 'cs', 'da', 'de', 'el', 'es', 'fa', 'fi', 'fr', 'he', 'hi', 'hu', 'id', 'it', 'ja', 'ko', 'nl', 'no', 'pl', 'pt', 'pt-BR',
  'ro', 'ru', 'sv', 'th', 'tr', 'uk', 'ur', 'vi', 'zh', 'zh-Hant',
];

export const RTL = new Set(['ar', 'he', 'fa', 'ur', 'yi', 'ps', 'sd', 'ug', 'dv', 'ckb']);
export const dirOf = (code: string) => (RTL.has(code.split('-')[0]!) ? 'rtl' : 'ltr');
