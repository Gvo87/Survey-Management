/**
 * Mapping between API answer values and `answers` rows ("cells"), per data model §2.5.
 * Most types use one row; matrix uses one row per matrix row and ranking one row per ranked
 * option (`sub_key`), so heatmaps and mean ranks are plain GROUP BYs.
 */
import { createHash } from 'node:crypto';
import { otherText, selectedOptionKeys, type AnswerValue, type Question } from '@survey/core';

export interface AnswerCell {
  questionKey: string;
  subKey: string;
  valueText: string | null;
  valueNumber: number | null;
  valueChoices: string[] | null;
  valueDate: string | null;
  valueJson: unknown;
  otherText: string | null;
}

const empty = (questionKey: string, subKey = ''): AnswerCell => ({
  questionKey,
  subKey,
  valueText: null,
  valueNumber: null,
  valueChoices: null,
  valueDate: null,
  valueJson: null,
  otherText: null,
});

/** Short hash of a consent statement: proves which wording the respondent agreed to. */
export const consentHash = (statement: string) => createHash('sha256').update(statement).digest('hex').slice(0, 16);

export function toCells(question: Question, value: AnswerValue): AnswerCell[] {
  const cell = empty(question.key);
  switch (question.type) {
    case 'single_choice':
    case 'dropdown':
    case 'multi_choice':
      cell.valueChoices = selectedOptionKeys(value);
      cell.otherText = otherText(value);
      return [cell];
    case 'likert': {
      const key = selectedOptionKeys(value)[0] ?? null;
      const index = question.options.findIndex((o) => o.key === key);
      cell.valueChoices = key ? [key] : null;
      cell.valueNumber = index === -1 ? null : (question.options[index]!.value ?? index + 1);
      return [cell];
    }
    case 'matrix': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
      return Object.entries(value as Record<string, string | string[]>).map(([row, cols]) => ({
        ...empty(question.key, row),
        valueChoices: Array.isArray(cols) ? cols : [cols],
      }));
    }
    case 'ranking':
      return Array.isArray(value)
        ? (value as string[]).map((option, i) => ({ ...empty(question.key, option), valueNumber: i + 1 }))
        : [];
    case 'rating':
    case 'nps':
    case 'slider':
      cell.valueNumber = Number(value);
      return [cell];
    case 'short_text':
      cell.valueText = String(value);
      if (question.config.format === 'number' || question.config.format === 'integer') cell.valueNumber = Number(value);
      return [cell];
    case 'long_text':
    case 'email':
    case 'phone':
      cell.valueText = String(value);
      return [cell];
    case 'date': {
      const text = String(value);
      cell.valueText = text;
      if ((question.config.mode ?? 'date') !== 'time') cell.valueDate = text.slice(0, 10);
      return [cell];
    }
    case 'file_upload':
      cell.valueJson = Array.isArray(value) ? value : [];
      return [cell];
    case 'consent':
      cell.valueNumber = value === true ? 1 : null;
      cell.valueText = consentHash(question.config.statement);
      return [cell];
  }
}

export function fromCells(question: Question, cells: AnswerCell[]): AnswerValue | null {
  if (question.type === 'matrix') {
    const value: Record<string, string | string[]> = {};
    for (const c of cells) {
      if (!c.subKey || !c.valueChoices?.length) continue;
      value[c.subKey] = question.config.multiplePerRow ? c.valueChoices : c.valueChoices[0]!;
    }
    return Object.keys(value).length ? value : null;
  }
  if (question.type === 'ranking') {
    const ranked = cells.filter((c) => c.subKey && c.valueNumber !== null).sort((a, b) => a.valueNumber! - b.valueNumber!);
    return ranked.length ? ranked.map((c) => c.subKey) : null;
  }
  const cell = cells.find((c) => c.subKey === '');
  if (!cell) return null;
  switch (question.type) {
    case 'single_choice':
    case 'dropdown': {
      const key = cell.valueChoices?.[0];
      if (!key) return null;
      return cell.otherText ? { option: key, other: cell.otherText } : key;
    }
    case 'multi_choice': {
      const keys = cell.valueChoices ?? [];
      return cell.otherText ? { options: keys, other: cell.otherText } : keys;
    }
    case 'likert':
      return cell.valueChoices?.[0] ?? null;
    case 'rating':
    case 'nps':
    case 'slider':
      return cell.valueNumber;
    case 'short_text':
    case 'long_text':
    case 'email':
    case 'phone':
      return cell.valueText;
    case 'date':
      return cell.valueText ?? cell.valueDate;
    case 'file_upload':
      return Array.isArray(cell.valueJson) ? (cell.valueJson as string[]) : null;
    case 'consent':
      return cell.valueNumber === 1 ? true : null;
  }
}
