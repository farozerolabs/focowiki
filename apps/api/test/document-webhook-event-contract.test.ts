import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WEBHOOK_EVENT_TYPES } from "../src/webhooks/events.js";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("document webhook event contract", () => {
  it("exposes only document lifecycle and deletion events", () => {
    expect(WEBHOOK_EVENT_TYPES).toEqual([
      "document.waiting",
      "document.processing",
      "document.available",
      "document.error",
      "document.deleting",
      "file.deleted",
      "knowledge_base.deleted"
    ]);
    expect(WEBHOOK_EVENT_TYPES.join("\n")).not.toMatch(
      /source_file\.|generation\.|publication/u
    );
  });

  it("emits waiting from every production document acceptance path", () => {
    for (const path of [
      "src/storage-vnext/upload/postgres-finalization.ts",
      "src/document-indexing/infrastructure/postgres-document-replacement.ts",
      "src/document-indexing/infrastructure/postgres-document-directory-move-staging.ts",
      "src/document-indexing/infrastructure/postgres-document-maintenance-scheduling.ts"
    ]) {
      const source = read(path);
      expect(source, path).toContain("enqueuePostgresDocumentWebhookEvent");
      expect(source, path).toContain('eventType: "document.waiting"');
    }
  });

  it("emits processing, error, deleting, and available from durable transitions", () => {
    const lifecycle = [
      "src/document-indexing/infrastructure/postgres-document-artifact-work-repository.ts",
      "src/document-indexing/infrastructure/postgres-document-work-claim.ts",
      "src/document-indexing/infrastructure/postgres-document-work-recovery.ts"
    ].map(read).join("\n");
    const finalization = read(
      "src/document-indexing/infrastructure/postgres-document-publication-work-activation.ts"
    );
    expect(lifecycle).toContain('eventType: "document.processing"');
    expect(lifecycle).toContain('eventType: "document.error"');
    expect(read(
      "src/document-indexing/infrastructure/postgres-document-deletion-acceptance.ts"
    )).toContain('eventType: "document.deleting"');
    expect(finalization).toContain('eventType: "document.available"');
  });

  it("emits lifecycle facts from retry, lease recovery, and deletion acceptance", () => {
    const retry = read(
      "src/document-indexing/infrastructure/postgres-document-retry.ts"
    );
    const lifecycle = [
      "src/document-indexing/infrastructure/postgres-document-artifact-work-repository.ts",
      "src/document-indexing/infrastructure/postgres-document-work-recovery.ts"
    ].map(read).join("\n");
    const deletion = read(
      "src/document-indexing/infrastructure/postgres-document-deletion-acceptance.ts"
    );
    expect(retry).toContain("enqueuePostgresDocumentWebhookEvent");
    expect(retry).toContain('eventType: "document.waiting"');
    expect(lifecycle).toContain("async recoverExpired");
    expect(lifecycle).toContain('eventType: "document.error"');
    expect(deletion).toContain("enqueuePostgresDocumentWebhookEvent");
    expect(deletion).toContain('eventType: "document.deleting"');
  });

  it("emits terminal deletion events from the durable cleanup transaction", () => {
    const deletion = read(
      "src/document-indexing/infrastructure/postgres-document-deletion-events.ts"
    );
    expect(deletion).toContain("enqueuePostgresStorageVnextWebhookEvents");
    expect(deletion).toContain('"file.deleted" as const');
    expect(deletion).toContain('"knowledge_base.deleted" as const');
  });

  it("runs the durable webhook delivery consumer in the unified worker", () => {
    const runtime = read(
      "src/document-indexing/infrastructure/production-runtime.ts"
    );
    expect(runtime).toContain("createPostgresStorageVnextWebhookRepository");
    expect(runtime).toContain("createStorageVnextWebhookWorker");
    expect(runtime).toContain("runWebhookDeliveryLoop");
  });
});
