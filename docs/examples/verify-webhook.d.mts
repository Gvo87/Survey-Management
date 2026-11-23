export function verifyWebhook(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  toleranceSec?: number,
): boolean;
