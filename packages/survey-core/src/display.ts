import type { Question } from './schema';
import { otherText, selectedOptionKeys, type AnswerValue } from './answers';

const labelOf = (options: { key: string; label: string }[], key: string) => options.find((o) => o.key === key)?.label ?? key;

/** Human-readable form of an answer (response viewer, CSV "compact" layout, webhooks). */
export function displayAnswer(question: Question, value: AnswerValue | null | undefined): string {
  if (value === null || value === undefined) return '';
  switch (question.type) {
    case 'single_choice':
    case 'dropdown':
    case 'likert':
    case 'multi_choice': {
      const labels = selectedOptionKeys(value).map((key) => {
        const option = question.options.find((o) => o.key === key);
        if (!option) return key;
        const other = option.isOther ? otherText(value) : null;
        return other ? `${option.label}: ${other}` : option.label;
      });
      return labels.join('; ');
    }
    case 'matrix': {
      if (typeof value !== 'object' || Array.isArray(value)) return '';
      return question.rows
        .filter((row) => (value as Record<string, string | string[]>)[row.key] !== undefined)
        .map((row) => {
          const cell = (value as Record<string, string | string[]>)[row.key]!;
          const columns = (Array.isArray(cell) ? cell : [cell]).map((c) => labelOf(question.options, c)).join(', ');
          return `${row.label}: ${columns}`;
        })
        .join('; ');
    }
    case 'ranking':
      return Array.isArray(value) ? value.map((key, i) => `${i + 1}. ${labelOf(question.options, key)}`).join('; ') : '';
    case 'consent':
      return value === true ? 'Agreed' : '';
    case 'file_upload':
      return Array.isArray(value) ? `${value.length} file${value.length === 1 ? '' : 's'}` : '';
    case 'slider':
      return question.config.unit ? `${value} ${question.config.unit}` : String(value);
    default:
      return String(value);
  }
}

/** Plain-text title: collapses whitespace so it fits in a CSV header or chart label. */
export function plainTitle(question: Question): string {
  return question.title.replace(/\s+/g, ' ').trim() || 'Untitled question';
}
