import { describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresDocumentGeneratedContext } from
  "../src/document-indexing/infrastructure/postgres-document-generated-context.js";

describe("document generated context", () => {
  it("normalizes PostgreSQL timestamps before rendering the update log", async () => {
    const terminalAt = new Date("2026-08-14T16:46:42.082Z");
    const sql = (async () => [{
      terminal_at: terminalAt,
      logical_path: "guides/overview.md",
      title: "Overview"
    }]) as unknown as DatabaseClient;
    const context = createPostgresDocumentGeneratedContext(sql);

    const events = await context.readRecentAvailableDocumentEvents({
      knowledgeBaseId: "knowledge-base-a",
      excludingSourceFilePublicIds: ["source-file-b"],
      limit: 10
    });

    expect(events).toEqual([{
      occurredAt: "2026-08-14T16:46:42.082Z",
      action: "Updated page",
      message: "Updated pages/guides/overview.md.",
      links: [{ path: "pages/guides/overview.md", title: "Overview" }]
    }]);
  });
});
