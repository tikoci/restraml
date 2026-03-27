/**
 * validate-openapi.ts — Validate an OpenAPI 3.0 JSON file
 *
 * Usage:
 *   bun validate-openapi.ts <openapi.json>
 *   bun validate-openapi.ts /tmp/oas-check/openapi.json
 *
 * Exit codes:
 *   0 — valid OpenAPI 3.0
 *   1 — validation errors found
 */

import SwaggerParser from "@apidevtools/swagger-parser";

const file = Bun.argv[2];
if (!file) {
  console.error("Usage: bun validate-openapi.ts <openapi.json>");
  process.exit(1);
}

try {
  const api = await SwaggerParser.validate(file) as Record<string, unknown>;
  const info = api.info as Record<string, string>;
  const paths = api.paths as Record<string, unknown> ?? {};
  console.log(
    `Valid OpenAPI ${api.openapi}: ${info.title} v${info.version}` +
      ` — ${Object.keys(paths).length} paths`,
  );
} catch (err) {
  console.error("OpenAPI validation failed:");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
