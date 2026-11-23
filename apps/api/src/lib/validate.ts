import type { z } from 'zod';
import { unprocessable } from './errors';

/** Parse request input with a contract schema; failures become 422 with field paths. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  throw unprocessable(
    'validation_failed',
    'Some fields are invalid.',
    result.error.issues.slice(0, 50).map((issue) => ({
      path: issue.path.map(String).join('.'),
      code: issue.code,
      message: issue.message,
    })),
  );
}
