/**
 * Third-party connectors (Phase 3A). Slack (an incoming webhook) is real and used by notification rules.
 * HubSpot and Google Sheets are defined here as interfaces with request builders and contract tests
 * against mocks, but they aren't wired to response events yet: there's no OAuth app behind them, so
 * they take a token pasted by an admin. Turning them on means calling `syncResponse` from the event
 * dispatcher and adding OAuth connect/callback routes.
 */

/** A completed response as a connector sees it (what a webhook payload carries). */
export interface ResponseRecord {
  surveyId: string;
  surveyTitle: string;
  responseId: string;
  completedAt: string | null;
  hiddenFields: Record<string, string>;
  answers: { questionKey: string; title: string; type: string; display: string }[];
}

export interface HttpCall {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Connector<Config> {
  kind: 'hubspot' | 'google_sheets';
  /** Non-secret details shown in the UI. */
  summary(config: Config): Record<string, string>;
  /** The HTTP calls that sync one response. Empty when there's nothing to send. */
  buildCalls(config: Config, record: ResponseRecord, baseUrl?: string): HttpCall[];
}

export interface HubspotConfig {
  accessToken: string;
  emailQuestionKey?: string;
}

/** Upserts the respondent as a HubSpot contact, keyed by the email they gave. */
export const hubspotConnector: Connector<HubspotConfig> = {
  kind: 'hubspot',
  summary: (config) => ({
    token: `…${config.accessToken.slice(-4)}`,
    emailQuestion: config.emailQuestionKey ?? 'first email question',
  }),
  buildCalls(config, record, baseUrl = 'https://api.hubapi.com') {
    const answer = config.emailQuestionKey
      ? record.answers.find((a) => a.questionKey === config.emailQuestionKey)
      : record.answers.find((a) => a.type === 'email');
    const email = answer?.display.trim().toLowerCase();
    if (!email || !email.includes('@')) return [];
    return [
      {
        method: 'POST',
        url: `${baseUrl}/crm/v3/objects/contacts/batch/upsert`,
        headers: { authorization: `Bearer ${config.accessToken}`, 'content-type': 'application/json' },
        body: {
          inputs: [
            {
              idProperty: 'email',
              id: email,
              properties: {
                email,
                survey_last_response_id: record.responseId,
                survey_last_survey: record.surveyTitle,
                survey_last_response_at: record.completedAt,
              },
            },
          ],
        },
      },
    ];
  },
};

export interface GoogleSheetsConfig {
  spreadsheetId: string;
  sheetName: string;
  accessToken: string;
}

/** Appends one row per response: id, completion time, then each answer as shown in exports. */
export const googleSheetsConnector: Connector<GoogleSheetsConfig> = {
  kind: 'google_sheets',
  summary: (config) => ({ spreadsheet: config.spreadsheetId, sheet: config.sheetName }),
  buildCalls(config, record, baseUrl = 'https://sheets.googleapis.com') {
    const range = encodeURIComponent(`${config.sheetName}!A1`);
    return [
      {
        method: 'POST',
        url: `${baseUrl}/v4/spreadsheets/${encodeURIComponent(config.spreadsheetId)}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        headers: { authorization: `Bearer ${config.accessToken}`, 'content-type': 'application/json' },
        body: {
          majorDimension: 'ROWS',
          // RAW input: values are never evaluated as formulas.
          values: [[record.responseId, record.completedAt ?? '', ...record.answers.map((a) => a.display)]],
        },
      },
    ];
  },
};

/** Run a connector's calls through a transport (real HTTP, or a mock in tests). */
export async function syncResponse<Config>(
  connector: Connector<Config>,
  config: Config,
  record: ResponseRecord,
  send: (call: HttpCall) => Promise<{ status: number }>,
  baseUrl?: string,
): Promise<{ calls: number }> {
  const calls = connector.buildCalls(config, record, baseUrl);
  for (const call of calls) {
    const res = await send(call);
    if (res.status < 200 || res.status >= 300) throw new Error(`${connector.kind} answered ${res.status}`);
  }
  return { calls: calls.length };
}
