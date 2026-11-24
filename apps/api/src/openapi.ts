/**
 * The curated public API document (OpenAPI 3.1), served at GET /api/v1/openapi.json. It covers exactly
 * the routes an API key may call (auth/api-keys.ts PUBLIC_ROUTES); request schemas are generated from
 * the same Zod contracts the API validates with. Webhook payloads are described under `webhooks`.
 */
import { z } from 'zod';
import {
  ContactsQuery,
  CreateSurveyRequest,
  CreateWebhookRequest,
  DeliveriesQuery,
  ExportQuery,
  ListMembersRequest,
  ListResponsesQuery,
  ListSurveysQuery,
  PublishRequest,
  ResultsQuery,
  SaveContactRequest,
  SaveListRequest,
  UpdateWebhookRequest,
  WEBHOOK_EVENTS,
} from '@survey/contracts';
import { PUBLIC_ROUTES } from './auth/api-keys';

interface RouteDoc {
  operationId: string;
  summary: string;
  tag: 'Surveys' | 'Responses' | 'Contacts' | 'Webhooks';
  body?: z.ZodType;
  query?: z.ZodType;
  /** The success status (default 200). */
  status?: number;
  /** The success body isn't JSON. */
  produces?: string;
  description?: string;
}

const DOCS: Record<string, RouteDoc> = {
  'GET /api/v1/surveys': {
    operationId: 'listSurveys',
    summary: 'List surveys',
    tag: 'Surveys',
    query: ListSurveysQuery,
  },
  'POST /api/v1/surveys': {
    operationId: 'createSurvey',
    summary: 'Create a survey with an empty draft',
    tag: 'Surveys',
    body: CreateSurveyRequest,
    status: 201,
  },
  'GET /api/v1/surveys/:id': { operationId: 'getSurvey', summary: 'Get a survey', tag: 'Surveys' },
  'GET /api/v1/surveys/:id/draft': {
    operationId: 'getDraft',
    summary: 'Get the draft (its ETag is the revision)',
    tag: 'Surveys',
  },
  'POST /api/v1/surveys/:id/draft': {
    operationId: 'createDraft',
    summary: 'Start a draft from the published version',
    tag: 'Surveys',
    status: 201,
  },
  'PUT /api/v1/surveys/:id/draft': {
    operationId: 'saveDraft',
    summary: 'Save the draft definition',
    tag: 'Surveys',
    body: z.object({ definition: z.record(z.string(), z.unknown()) }),
    description: 'Send `If-Match: "rev-{revision}"`. A stale revision answers 409 revision_conflict.',
  },
  'POST /api/v1/surveys/:id/publish': {
    operationId: 'publishSurvey',
    summary: 'Publish the draft',
    tag: 'Surveys',
    body: PublishRequest,
    description:
      'Answers 202 with `{ approvalRequest }` when the organization requires approval before publishing.',
  },
  'POST /api/v1/surveys/:id/close': {
    operationId: 'closeSurvey',
    summary: 'Stop accepting responses',
    tag: 'Surveys',
  },
  'POST /api/v1/surveys/:id/reopen': {
    operationId: 'reopenSurvey',
    summary: 'Accept responses again',
    tag: 'Surveys',
  },
  'POST /api/v1/surveys/:id/archive': {
    operationId: 'archiveSurvey',
    summary: 'Archive a survey',
    tag: 'Surveys',
  },
  'GET /api/v1/surveys/:id/versions': {
    operationId: 'listVersions',
    summary: 'List published versions',
    tag: 'Surveys',
  },
  'GET /api/v1/surveys/:id/versions/:versionId': {
    operationId: 'getVersion',
    summary: 'Get a published version and its definition',
    tag: 'Surveys',
  },
  'GET /api/v1/surveys/:id/results/summary': {
    operationId: 'getResultsSummary',
    summary: 'Results summary',
    tag: 'Responses',
    query: ResultsQuery,
  },
  'GET /api/v1/surveys/:id/responses': {
    operationId: 'listResponses',
    summary: 'List responses',
    tag: 'Responses',
    query: ListResponsesQuery,
  },
  'GET /api/v1/surveys/:id/responses/:responseId': {
    operationId: 'getResponse',
    summary: 'Get a response with its answers',
    tag: 'Responses',
  },
  'DELETE /api/v1/surveys/:id/responses/:responseId': {
    operationId: 'deleteResponse',
    summary: 'Delete a response (audited)',
    tag: 'Responses',
    status: 204,
  },
  'GET /api/v1/surveys/:id/export.csv': {
    operationId: 'exportResponsesCsv',
    summary: 'Export responses as CSV',
    tag: 'Responses',
    query: ExportQuery,
    produces: 'text/csv',
  },
  'GET /api/v1/contacts': {
    operationId: 'listContacts',
    summary: 'List contacts',
    tag: 'Contacts',
    query: ContactsQuery,
  },
  'POST /api/v1/contacts': {
    operationId: 'createContact',
    summary: 'Create a contact',
    tag: 'Contacts',
    body: SaveContactRequest,
    status: 201,
  },
  'PATCH /api/v1/contacts/:id': {
    operationId: 'updateContact',
    summary: 'Update a contact',
    tag: 'Contacts',
    body: SaveContactRequest.partial(),
  },
  'DELETE /api/v1/contacts/:id': {
    operationId: 'deleteContact',
    summary: 'Delete a contact',
    tag: 'Contacts',
    status: 204,
  },
  'GET /api/v1/contact-lists': {
    operationId: 'listContactLists',
    summary: 'List contact lists',
    tag: 'Contacts',
  },
  'POST /api/v1/contact-lists': {
    operationId: 'createContactList',
    summary: 'Create a contact list',
    tag: 'Contacts',
    body: SaveListRequest,
    status: 201,
  },
  'PATCH /api/v1/contact-lists/:id': {
    operationId: 'renameContactList',
    summary: 'Rename a contact list',
    tag: 'Contacts',
    body: SaveListRequest,
  },
  'DELETE /api/v1/contact-lists/:id': {
    operationId: 'deleteContactList',
    summary: 'Delete a contact list',
    tag: 'Contacts',
    status: 204,
  },
  'POST /api/v1/contact-lists/:id/members': {
    operationId: 'addListMembers',
    summary: 'Add contacts to a list',
    tag: 'Contacts',
    body: ListMembersRequest,
  },
  'POST /api/v1/contact-lists/:id/members/remove': {
    operationId: 'removeListMembers',
    summary: 'Remove contacts from a list',
    tag: 'Contacts',
    body: ListMembersRequest,
  },
  'GET /api/v1/contacts/imports/:id': {
    operationId: 'getContactImport',
    summary: 'Get a CSV import',
    tag: 'Contacts',
  },
  'GET /api/v1/webhooks': { operationId: 'listWebhooks', summary: 'List webhook endpoints', tag: 'Webhooks' },
  'POST /api/v1/webhooks': {
    operationId: 'createWebhook',
    summary: 'Register a webhook endpoint',
    tag: 'Webhooks',
    body: CreateWebhookRequest,
    status: 201,
    description: 'The signing `secret` is in this response only.',
  },
  'GET /api/v1/webhooks/:id': {
    operationId: 'getWebhook',
    summary: 'Get a webhook endpoint',
    tag: 'Webhooks',
  },
  'PATCH /api/v1/webhooks/:id': {
    operationId: 'updateWebhook',
    summary: 'Update or re-enable a webhook endpoint',
    tag: 'Webhooks',
    body: UpdateWebhookRequest,
  },
  'DELETE /api/v1/webhooks/:id': {
    operationId: 'deleteWebhook',
    summary: 'Delete a webhook endpoint',
    tag: 'Webhooks',
    status: 204,
  },
  'POST /api/v1/webhooks/:id/rotate-secret': {
    operationId: 'rotateWebhookSecret',
    summary: 'Rotate the signing secret',
    tag: 'Webhooks',
    description: 'The previous secret also signs (a second v1= value) for 24 hours.',
  },
  'POST /api/v1/webhooks/:id/test': {
    operationId: 'testWebhook',
    summary: 'Send a ping event now',
    tag: 'Webhooks',
  },
  'GET /api/v1/webhooks/:id/deliveries': {
    operationId: 'listDeliveries',
    summary: 'List deliveries',
    tag: 'Webhooks',
    query: DeliveriesQuery,
  },
  'GET /api/v1/webhooks/:id/deliveries/:deliveryId': {
    operationId: 'getDelivery',
    summary: 'Get a delivery with every attempt',
    tag: 'Webhooks',
  },
  'POST /api/v1/webhooks/:id/deliveries/:deliveryId/redeliver': {
    operationId: 'redeliver',
    summary: 'Try a finished delivery once more',
    tag: 'Webhooks',
    status: 202,
  },
};

/** JSON Schema for a request part. Transforms and defaults are described as their input. */
function schemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...json } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  return json;
}

function queryParameters(schema: z.ZodType) {
  const json = schemaOf(schema) as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  return Object.entries(json.properties ?? {}).map(([name, property]) => ({
    name,
    in: 'query',
    required: json.required?.includes(name) ?? false,
    // Query strings are text; numbers and booleans arrive as strings and are coerced.
    schema: property,
  }));
}

const problem = {
  description: 'An error (RFC 9457).',
  content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
};

export function buildOpenApiDocument(serverUrl: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [route, scope] of Object.entries(PUBLIC_ROUTES)) {
    const doc = DOCS[route];
    if (!doc) throw new Error(`No OpenAPI description for ${route}`);
    const [method, path] = route.split(' ') as [string, string];
    const openApiPath = path.replace(/:(\w+)/g, '{$1}');
    const pathParams = [...path.matchAll(/:(\w+)/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    }));
    const status = String(doc.status ?? 200);
    paths[openApiPath] ??= {};
    paths[openApiPath][method.toLowerCase()] = {
      operationId: doc.operationId,
      summary: doc.summary,
      tags: [doc.tag],
      description: [doc.description, `Requires the \`${scope}\` scope.`].filter(Boolean).join('\n\n'),
      security: [{ apiKey: [] }],
      'x-required-scope': scope,
      parameters: [
        ...pathParams,
        ...(doc.query ? queryParameters(doc.query) : []),
        ...(method === 'POST'
          ? [
              {
                name: 'Idempotency-Key',
                in: 'header',
                required: false,
                description:
                  'Replaying the same request with the same key within 24 hours returns the first result.',
                schema: { type: 'string', maxLength: 255 },
              },
            ]
          : []),
      ],
      ...(doc.body
        ? { requestBody: { required: true, content: { 'application/json': { schema: schemaOf(doc.body) } } } }
        : {}),
      responses: {
        [status]:
          status === '204'
            ? { description: 'Done.' }
            : {
                description: 'Success.',
                content: {
                  [doc.produces ?? 'application/json']: {
                    schema: doc.produces ? { type: 'string' } : { type: 'object' },
                  },
                },
              },
        '401': problem,
        '403': problem,
        '404': problem,
        '422': problem,
        '429': problem,
      },
    };
  }

  const envelope = (type: string, data: Record<string, unknown>) => ({
    type: 'object',
    required: ['id', 'type', 'createdAt', 'data'],
    properties: {
      id: {
        type: 'string',
        description: 'evt_… Same value as the Survey-Webhook-Id header; stable across retries.',
      },
      type: { const: type },
      createdAt: { type: 'string', format: 'date-time' },
      data: { type: 'object', properties: data },
    },
  });
  const webhookPayloads: Record<string, Record<string, unknown>> = {
    'response.submitted': envelope('response.submitted', {
      surveyId: { type: 'string' },
      responseId: { type: 'string' },
      status: { enum: ['completed', 'disqualified'] },
      versionNumber: { type: 'integer' },
      completedAt: { type: ['string', 'null'] },
      hiddenFields: { type: 'object', additionalProperties: { type: 'string' } },
      answers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            questionKey: { type: 'string' },
            title: { type: 'string' },
            type: { type: 'string' },
            value: {},
            display: { type: 'string' },
          },
        },
      },
    }),
    'survey.published': envelope('survey.published', {
      surveyId: { type: 'string' },
      title: { type: 'string' },
      versionNumber: { type: 'integer' },
      publishedAt: { type: 'string' },
      publicUrl: { type: 'string' },
    }),
    'survey.closed': envelope('survey.closed', {
      surveyId: { type: 'string' },
      title: { type: 'string' },
      reason: { enum: ['manual', 'close_date', 'quota', null] },
      closedAt: { type: 'string' },
    }),
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'Survey Platform API',
      version: '1.0.0',
      description:
        'Authenticate with `Authorization: Bearer sk_live_…` (create keys under Settings → API). Each key has scopes and ' +
        'a rate limit (RateLimit-* headers; 429 with Retry-After). Errors are RFC 9457 problem documents with a stable `code`.',
    },
    servers: [{ url: serverUrl }],
    tags: [{ name: 'Surveys' }, { name: 'Responses' }, { name: 'Contacts' }, { name: 'Webhooks' }],
    paths,
    webhooks: Object.fromEntries(
      WEBHOOK_EVENTS.map((event) => [
        event,
        {
          post: {
            summary: `${event} event`,
            description:
              'Signed with Survey-Webhook-Signature: v1=hex(HMAC_SHA256(secret, timestamp + "." + body)). Reject timestamps older than 5 minutes.',
            parameters: [
              { name: 'Survey-Webhook-Id', in: 'header', required: true, schema: { type: 'string' } },
              { name: 'Survey-Webhook-Timestamp', in: 'header', required: true, schema: { type: 'string' } },
              { name: 'Survey-Webhook-Signature', in: 'header', required: true, schema: { type: 'string' } },
            ],
            requestBody: {
              required: true,
              content: { 'application/json': { schema: webhookPayloads[event] } },
            },
            responses: { '200': { description: 'Any 2xx within 10 seconds counts as delivered.' } },
          },
        },
      ]),
    ),
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'An API key: sk_live_…' } },
      schemas: {
        Problem: {
          type: 'object',
          required: ['type', 'title', 'status', 'code'],
          properties: {
            type: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'integer' },
            code: { type: 'string' },
            detail: { type: 'string' },
            errors: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  code: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
            requestId: { type: 'string' },
          },
        },
      },
    },
  };
}
