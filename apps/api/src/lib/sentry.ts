/** Optional error tracking: only loaded when SENTRY_DSN is set. */
type Capture = (error: unknown, context?: Record<string, unknown>) => void;

let capture: Capture = () => {};

export async function initSentry(dsn: string | null, environment: string): Promise<void> {
  if (!dsn) return;
  try {
    const Sentry = await import('@sentry/node');
    Sentry.init({
      dsn,
      environment,
      sendDefaultPii: false,
      beforeSend(event) {
        // Never ship request bodies, cookies or headers: they can hold answers and credentials.
        if (event.request) {
          delete event.request.data;
          delete event.request.cookies;
          delete event.request.headers;
        }
        return event;
      },
    });
    capture = (error, context) => Sentry.captureException(error, { extra: context });
  } catch (error) {
    console.warn(
      '[sentry] SENTRY_DSN is set but @sentry/node could not be loaded:',
      (error as Error).message,
    );
  }
}

export const captureError: Capture = (error, context) => capture(error, context);
