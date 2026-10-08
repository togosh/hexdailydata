import { endpointGroups } from './api-guide.ts';
// A small reader for this generated document, not a JSON Schema interpreter.
export interface ParameterSchema {
  type?: string | string[];
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
  pattern?: string;
  [key: string]: unknown;
}
export interface Parameter {
  name: string;
  in: string;
  required: boolean;
  description: string;
  schema: ParameterSchema;
}
export interface RequestExample {
  label: string;
  path: string;
  variant?: string;
  template?: boolean;
  note?: string;
}
export interface ResponseDoc {
  description: string;
  headers?: Record<string, { description: string; schema: unknown }>;
  content?: Record<
    string,
    { schema: unknown; examples?: Record<string, { summary: string; value: unknown }> }
  >;
}
export interface Operation {
  operationId: string;
  summary: string;
  description: string;
  parameters: Parameter[];
  responses: Record<string, ResponseDoc>;
  'x-rules': string[];
  'x-requests': RequestExample[];
}
export interface ReferenceDocument {
  paths: Record<string, { get: Operation }>;
  'x-essentials': Record<string, string>;
}
export const resources = endpointGroups.flatMap((group) =>
  group.routes.map((route) => ({ ...route, group: group.id })),
);
export function selection(hash: string) {
  if (!hash || hash === '#api-essentials' || hash === '#content')
    return { id: 'home', unknown: false };
  const found = resources.find(
    (route) =>
      hash === `#tag/${route.group}/${route.id}` || hash === `#tag/${route.group}/${route.id}Head`,
  );
  return { id: found?.id ?? 'home', unknown: !found };
}
export function matchingResources(query: string) {
  const needle = query.trim().toLowerCase();
  return resources.filter((route) =>
    (route.title + ' ' + route.path).toLowerCase().includes(needle),
  );
}
export function parameterFacts(schema: ParameterSchema) {
  const facts = [
    Object.hasOwn(schema, 'default') ? `Default: ${JSON.stringify(schema.default)}` : 'No default',
  ];
  if (schema.enum) facts.push('Allowed: ' + schema.enum.map((v) => JSON.stringify(v)).join(', '));
  if (Object.hasOwn(schema, 'const')) facts.push('Allowed: ' + JSON.stringify(schema.const));
  if (schema.minimum !== undefined) facts.push('Min: ' + schema.minimum);
  if (schema.maximum !== undefined) facts.push('Max: ' + schema.maximum);
  if (schema.minLength !== undefined) facts.push('Min length: ' + schema.minLength);
  if (schema.maxLength !== undefined) facts.push('Max length: ' + schema.maxLength);
  if (schema.format) facts.push('Format: ' + schema.format);
  if (schema.pattern)
    facts.push(
      schema.pattern.length <= 85
        ? 'Pattern: ' + schema.pattern
        : 'Pattern: see exact parameter JSON',
    );
  if (schema.anyOf || schema.oneOf || schema.allOf)
    facts.push('Alternatives: see exact parameter JSON');
  return facts;
}
export const responseLabel = (key: string): string =>
  (
    ({
      native: 'Native history',
      sourceReported: 'Source-reported HDS',
      partial: 'Partial address',
      synthetic: 'Synthetic example',
    }) as Record<string, string>
  )[key] ?? key;
export const errorAction = (status: string): string =>
  (
    ({
      401: 'Use a valid API key; there is no public fallback.',
      403: 'Active paid access is required for this selection; see /api.',
      400: 'Check parameters and bounds.',
      405: 'Use a read method.',
      409: 'Restart with a consistent selection.',
      410: 'Refresh the catalog.',
      429: 'Honor Retry-After; back off.',
      503: 'Inspect availability; retry only with bounded backoff.',
    }) as Record<string, string>
  )[status] ?? 'Inspect the error code and requestId.';
