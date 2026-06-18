import { createDeveloperOpenApiFieldContinuity } from "./openapi-field-continuity.js";
import { createDeveloperOpenApiPaths } from "./openapi-paths.js";
import { createDeveloperOpenApiSchemas } from "./openapi-schemas.js";
import { bearerSecurity } from "./openapi-shared.js";

export function createDeveloperOpenApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Focowiki Developer OpenAPI",
      version: "0.1.0",
      description:
        "Authenticated API for integrating Focowiki knowledge bases, uploads, generated files, and webhooks.",
      license: {
        name: "Modified Apache License 2.0",
        url: "https://www.apache.org/licenses/LICENSE-2.0"
      }
    },
    servers: [{ url: "/" }],
    security: bearerSecurity,
    tags: [
      { name: "Metadata", description: "Health, version, and contract discovery." },
      { name: "Knowledge Bases", description: "Knowledge-base lifecycle and upload entry points." },
      { name: "Source Files", description: "Source-file processing observation and retry." },
      { name: "Files", description: "Generated tree, file detail, content, and deletion reads." },
      { name: "Webhooks", description: "Webhook subscriptions and delivery operations." }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "Focowiki OpenAPI key"
        }
      },
      schemas: createDeveloperOpenApiSchemas()
    },
    "x-field-continuity": createDeveloperOpenApiFieldContinuity(),
    paths: createDeveloperOpenApiPaths()
  };
}
