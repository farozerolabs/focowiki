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
        "Authenticated API for creating knowledge bases, uploading Markdown, reading published files, managing content, and receiving webhooks.",
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
      { name: "Upload Sessions", description: "Resumable Markdown uploads that preserve file and folder paths." },
      { name: "Uploaded Directories", description: "Directories created from uploaded folder paths." },
      { name: "Uploaded Files", description: "Uploaded Markdown content, processing status, replacement, movement, retry, and deletion." },
      { name: "File and Directory Changes", description: "Progress and results for file and directory moves, replacements, and deletions." },
      { name: "Files", description: "Published file tree, content, search, and file relationships." },
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
