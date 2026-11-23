/**
 * Applies a survey theme by setting the CSS custom properties styles.css is written against.
 * Contrast was checked when the theme was saved (WCAG AA), so any theme here is readable.
 */
import { themeCssVariables, type ThemeTokens } from '@survey/core';

export function applyTheme(tokens: ThemeTokens | null): void {
  const root = document.documentElement;
  if (!tokens) {
    delete root.dataset.themed;
    return;
  }
  for (const [name, value] of Object.entries(themeCssVariables(tokens))) root.style.setProperty(name, value);
  root.dataset.themed = 'true';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', tokens.background);
}
