/**
 * CSV encoding (RFC 4180) with formula-injection protection: a cell starting with
 * = + - @ tab or carriage return is prefixed with an apostrophe so spreadsheet apps
 * treat it as text instead of executing it.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function csvRow(values: unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}

/** Excel needs a BOM to read UTF-8 CSV correctly (non-Latin text). */
export const UTF8_BOM = '﻿';
