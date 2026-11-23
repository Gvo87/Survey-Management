/**
 * Mapping between API answer values and `answers` rows ("cells"), per data model §2.5.
 * One row per answer for every Phase 1 type; matrix and ranking (Phase 2A) will use sub_key.
 */
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

const empty = (questionKey: string): AnswerCell => ({
  questionKey,
  subKey: '',
  valueText: null,
  valueNumber: null,
  valueChoices: null,
  valueDate: null,
  valueJson: null,
  otherText: null,
});

export function toCells(question: Question, value: AnswerValue): AnswerCell[] {
  const cell = empty(question.key);
  switch (question.type) {
    case 'single_choice':
    case 'dropdown':
    case 'multi_choice':
      cell.valueChoices = selectedOptionKeys(value);
      cell.otherText = otherText(value);
      break;
    case 'likert': {
      const key = selectedOptionKeys(value)[0] ?? null;
      const index = question.options.findIndex((o) => o.key === key);
      cell.valueChoices = key ? [key] : null;
      cell.valueNumber = index === -1 ? null : (question.options[index]!.value ?? index + 1);
      break;
    }
    case 'rating':
    case 'nps':
      cell.valueNumber = Number(value);
      break;
    case 'short_text':
    case 'long_text':
    case 'email':
      cell.valueText = String(value);
      break;
    case 'date':
      cell.valueText = String(value);
      cell.valueDate = String(value);
      break;
  }
  return [cell];
}

export function fromCells(question: Question, cells: AnswerCell[]): AnswerValue | null {
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
      return cell.valueNumber;
    case 'short_text':
    case 'long_text':
    case 'email':
      return cell.valueText;
    case 'date':
      return cell.valueText ?? cell.valueDate;
  }
}
