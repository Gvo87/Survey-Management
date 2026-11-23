/**
 * Survey themes: a few tokens, checked for WCAG 2.1 AA contrast. The same check runs in the theme
 * editor (to block saving) and in the API (so nothing bypasses it).
 */
export const THEME_FONTS = {
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  humanist: "'Seravek', 'Gill Sans Nova', Ubuntu, Calibri, 'DejaVu Sans', source-sans-pro, sans-serif",
  rounded: "ui-rounded, 'Hiragino Maru Gothic ProN', Quicksand, Comfortaa, Manjari, 'Arial Rounded MT', Calibri, source-sans-pro, sans-serif",
  serif: "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif",
  mono: "ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
} as const;
export type ThemeFont = keyof typeof THEME_FONTS;

export const THEME_RADII = { none: '0px', small: '4px', medium: '10px', large: '18px' } as const;
export type ThemeRadius = keyof typeof THEME_RADII;

export interface ThemeTokens {
  /** Buttons, selected options, progress bar. */
  primary: string;
  /** Page background. */
  background: string;
  /** Card / question background. */
  surface: string;
  /** Body text. */
  text: string;
  font: ThemeFont;
  radius: ThemeRadius;
}

export const DEFAULT_THEME: ThemeTokens = {
  primary: '#2445a8',
  background: '#f6f7f9',
  surface: '#ffffff',
  text: '#1b1f24',
  font: 'system',
  radius: 'medium',
};

const HEX = /^#[0-9a-fA-F]{6}$/;
export const isHexColor = (v: string) => HEX.test(v);

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1–21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** White or near-black, whichever reads better on `background`. */
export function inkFor(background: string): '#ffffff' | '#111111' {
  return contrastRatio('#ffffff', background) >= contrastRatio('#111111', background) ? '#ffffff' : '#111111';
}

export interface ContrastProblem {
  pair: string;
  ratio: number;
  required: number;
  message: string;
}

/**
 * WCAG 2.1 AA checks: body text 4.5:1 on background and surface; button text 4.5:1 on primary;
 * primary (borders, selected states, focus) 3:1 against the surface.
 */
export function checkThemeContrast(tokens: ThemeTokens): ContrastProblem[] {
  const problems: ContrastProblem[] = [];
  for (const key of ['primary', 'background', 'surface', 'text'] as const) {
    if (!isHexColor(tokens[key])) problems.push({ pair: key, ratio: 0, required: 0, message: `${key} must be a colour like #2445a8.` });
  }
  if (problems.length) return problems;
  const check = (pair: string, a: string, b: string, required: number, what: string) => {
    const ratio = contrastRatio(a, b);
    if (ratio < required) problems.push({ pair, ratio, required, message: `${what}: contrast ${ratio}:1, needs at least ${required}:1.` });
  };
  check('text/background', tokens.text, tokens.background, 4.5, 'Text on the page background');
  check('text/surface', tokens.text, tokens.surface, 4.5, 'Text on question cards');
  check('button', inkFor(tokens.primary), tokens.primary, 4.5, 'Button text on the primary colour');
  check('primary/surface', tokens.primary, tokens.surface, 3, 'Primary colour against question cards');
  return problems;
}

/** CSS custom properties consumed by the respondent app's stylesheet. */
export function themeCssVariables(tokens: ThemeTokens): Record<string, string> {
  return {
    '--primary': tokens.primary,
    '--primary-hover': tokens.primary,
    '--on-primary': inkFor(tokens.primary),
    '--bg': tokens.background,
    '--surface': tokens.surface,
    '--text': tokens.text,
    '--radius': THEME_RADII[tokens.radius],
    '--font': THEME_FONTS[tokens.font],
  };
}
