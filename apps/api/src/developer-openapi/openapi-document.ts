import { createDeveloperOpenApiPaths } from "./openapi-paths.js";
import { createDeveloperOpenApiSchemas } from "./openapi-schemas.js";
import { bearerSecurity } from "./openapi-shared.js";
import { readProductReleaseVersion } from "../release-version.js";

export function createDeveloperOpenApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Focowiki Developer OpenAPI",
      version: readProductReleaseVersion(),
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
      { name: "Knowledge Bases", description: "Knowledge-base creation, metadata, listing, and deletion." },
      { name: "Upload Sessions", description: "Resumable Markdown uploads that preserve relative paths." },
      { name: "Source Directories", description: "Source-directory listing, movement, and deletion." },
      { name: "Source Files", description: "Source-file content, processing, replacement, movement, retry, and deletion." },
      { name: "Resource Operations", description: "Status and results for asynchronous source changes." },
      { name: "Files", description: "Generated file tree, content, search, and relationship exploration." },
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
    paths: createDeveloperOpenApiPaths()
  };
}
