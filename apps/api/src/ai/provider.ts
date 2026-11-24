/**
 * AI summaries of open-text answers (Phase 3B, open question Q10: OpenAI, opt-in per org).
 *
 * The provider sits behind this small interface so tests use a deterministic fake and the real client can
 * be swapped. Answer text is untrusted data: the provider only ever returns a summary in a fixed JSON
 * shape, never actions, and every response id it returns is checked against the ids it was sent.
 */

export interface SummaryInput {
  /** The question, for context. */
  question: string;
  /** Answers after redaction, with opaque short ids (never response ids or personal data). */
  answers: { id: string; text: string }[];
  /** Ask for at most this many themes. */
  maxThemes: number;
}

export interface SummaryTheme {
  label: string;
  summary: string;
  sentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
  /** Ids from the input that belong to this theme. */
  answerIds: string[];
}

export interface SummaryOutput {
  summary: string;
  themes: SummaryTheme[];
  /** Overall sentiment as counts of answers. */
  sentiment: { positive: number; neutral: number; negative: number };
  usage: { inputTokens: number; outputTokens: number };
}

export interface AiProvider {
  /** `openai` or `fake`. Shown with every summary. */
  readonly name: string;
  readonly model: string;
  summarize(input: SummaryInput): Promise<SummaryOutput>;
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly code: 'provider_error' | 'invalid_output' | 'rate_limited' | 'timeout',
  ) {
    super(message);
  }
}

/** A rough token estimate (about 4 characters per token) used to check the cap before calling. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);
