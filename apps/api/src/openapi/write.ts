import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { buildOpenApiDocument } from './document.js';

// `npm run openapi`: rewrites the committed OpenAPI document.
export const OPENAPI_PATH = resolve(import.meta.dirname, '../../../../docs/api/openapi.json');

export function serializeOpenApi(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  writeFileSync(OPENAPI_PATH, serializeOpenApi());
  console.log(`Wrote ${OPENAPI_PATH}`);
}
