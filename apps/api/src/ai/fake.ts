/**
 * A deterministic stand-in for the AI provider (tests, demos and end-to-end runs: AI_PROVIDER=fake).
 * Groups answers by their most frequent meaningful word and scores sentiment from a small word list, so
 * the same answers always give the same summary. Labelled with the model `fake-summarizer`.
 */
import { STOP_WORDS } from '../lib/stop-words';
import { estimateTokens, type AiProvider, type SummaryInput, type SummaryOutput } from './provider';

const STOP = new Set<string>(STOP_WORDS);
const POSITIVE = new Set(['good', 'great', 'love', 'loved', 'excellent', 'friendly', 'fast', 'helpful', 'easy', 'nice', 'happy', 'amazing', 'quick']);
const NEGATIVE = new Set(['bad', 'slow', 'poor', 'hate', 'terrible', 'broken', 'expensive', 'rude', 'hard', 'confusing', 'late', 'awful', 'bug', 'bugs']);

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOP.has(w) && w !== 'email' && w !== 'phone');

function score(text: string): 'positive' | 'neutral' | 'negative' {
  let s = 0;
  for (const w of words(text)) s += POSITIVE.has(w) ? 1 : NEGATIVE.has(w) ? -1 : 0;
  return s > 0 ? 'positive' : s < 0 ? 'negative' : 'neutral';
}

export const fakeAiProvider: AiProvider = {
  name: 'fake',
  model: 'fake-summarizer',
  async summarize(input: SummaryInput): Promise<SummaryOutput> {
    const frequency = new Map<string, number>();
    for (const a of input.answers) for (const w of new Set(words(a.text))) frequency.set(w, (frequency.get(w) ?? 0) + 1);
    const top = [...frequency.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, input.maxThemes)
      .map(([w]) => w);
    const assigned = new Set<string>();
    const themes = top.flatMap((word) => {
      const members = input.answers.filter((a) => !assigned.has(a.id) && words(a.text).includes(word));
      if (members.length === 0) return [];
      for (const m of members) assigned.add(m.id);
      const tally = { positive: 0, neutral: 0, negative: 0 };
      for (const m of members) tally[score(m.text)]++;
      const sentiment = tally.positive > tally.negative ? (tally.negative ? 'mixed' : 'positive') : tally.negative > tally.positive ? 'negative' : 'neutral';
      return [
        {
          label: word[0]!.toUpperCase() + word.slice(1),
          summary: `${members.length} ${members.length === 1 ? 'answer mentions' : 'answers mention'} “${word}”.`,
          sentiment: sentiment as SummaryOutput['themes'][number]['sentiment'],
          answerIds: members.map((m) => m.id),
        },
      ];
    });
    const sentiment = { positive: 0, neutral: 0, negative: 0 };
    for (const a of input.answers) sentiment[score(a.text)]++;
    const prompt = input.question + input.answers.map((a) => a.text).join('\n');
    const summary = themes.length
      ? `Respondents most often mentioned ${themes.map((t) => t.label.toLowerCase()).slice(0, 3).join(', ')}.`
      : 'No recurring themes in these answers.';
    return {
      summary,
      themes,
      sentiment,
      usage: { inputTokens: estimateTokens(prompt) + 200, outputTokens: estimateTokens(JSON.stringify(themes)) + 20 },
    };
  },
};
