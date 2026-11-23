import type { Question } from './schema';
import { otherText, selectedOptionKeys, type AnswerValue } from './answers';

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
    default:
      return String(value);
  }
}

/** Plain-text title: collapses whitespace so it fits in a CSV header or chart label. */
export function plainTitle(question: Question): string {
  return question.title.replace(/\s+/g, ' ').trim() || 'Untitled question';
}
