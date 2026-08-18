import { describe, expect, it, vi } from "vitest";
import { ensureDocumentSearchIndex } from
  "../src/document-indexing/application/document-search-index-ensure.js";
import { createStorageVnextSearchSettings } from
  "../src/storage-vnext/search/settings.js";

describe("document search index ensure", () => {
  it("creates and verifies a missing provider index", async () => {
    const definition = createStorageVnextSearchSettings({ searchCutoffMs: 500 });
    let exists = false;
    let applied: typeof definition | null = null;
    const provider = {
      admin: {
        getIndex: vi.fn(async () => exists ? { primaryKey: "id" } : null),
        createIndex: vi.fn(async () => {
          exists = true;
          applied = definition;
          return { state: "completed" as const };
        }),
        getIndexDefinition: vi.fn(async () => applied),
        updateIndexDefinition: vi.fn(async ({ definition: next }) => {
          applied = next;
          return { state: "completed" as const };
        })
      }
    };

    await ensureDocumentSearchIndex({
      provider: provider as never,
      indexUid: "focowiki_test",
      definition,
      settings: {} as never,
      signal: new AbortController().signal,
      awaitReceipt: vi.fn(async () => undefined)
    });

    expect(provider.admin.createIndex).toHaveBeenCalledTimes(1);
    expect(provider.admin.updateIndexDefinition).not.toHaveBeenCalled();
  });

  it("recovers a concurrent create when the index now exists", async () => {
    const definition = createStorageVnextSearchSettings({ searchCutoffMs: 500 });
    let reads = 0;
    const provider = {
      admin: {
        getIndex: vi.fn(async () => ++reads === 1
          ? null : { primaryKey: "id" }),
        createIndex: vi.fn(async () => ({
          state: "pending" as const,
          operationRef: "concurrent-create"
        })),
        getIndexDefinition: vi.fn(async () => definition),
        updateIndexDefinition: vi.fn()
      }
    };

    await expect(ensureDocumentSearchIndex({
      provider: provider as never,
      indexUid: "focowiki_test",
      definition,
      settings: {} as never,
      signal: new AbortController().signal,
      awaitReceipt: vi.fn(async () => {
        throw Object.assign(new Error("already exists"), { code: "conflict" });
      })
    })).resolves.toBeUndefined();
  });
});
