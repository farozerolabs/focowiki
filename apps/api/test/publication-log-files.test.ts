import { describe, expect, it } from "vitest";

import { renderLogFiles } from "../src/okf/publication-files.js";

describe("renderLogFiles", () => {
  it("keeps the root log bounded and chains typed history concepts", () => {
    const files = renderLogFiles(
      [],
      100_000,
      "2026-07-13T00:00:00.000Z",
      { maxEntries: 2, maxBytes: 2_048 },
      {
        entries: Array.from({ length: 7 }, (_, index) => ({
          occurredAt: `2026-06-${String(30 - index).padStart(2, "0")}T00:00:00.000Z`,
          action: "Update",
          message: `Retained publication event ${index + 1}.`,
          changedFileCount: index + 1
        })),
        summaries: []
      },
      { created: 0, updated: 0, moved: 0, deleted: 0, affectedDirectories: [] }
    );

    const root = files[0];
    const history = files.slice(1);
    expect(root?.content).toContain("[Update history page 1](/log-000001.md)");
    expect(root?.content).not.toContain("Update history page 2");
    expect(history).toHaveLength(4);
    expect(history.every((file) => file.fileKind === "history_page")).toBe(true);
    expect(history[0]).toMatchObject({
      logicalPath: "log-000001.md",
      metadata: {
        type: "Update History Page",
        title: "Update history page 1",
        description: "Retained publication details for update history page 1."
      }
    });
    expect(history[0]?.content).toContain('type: "Update History Page"');
    expect(history[0]?.content).toContain('title: "Update history page 1"');
    expect(history[0]?.content).toContain("[Next page](/log-000002.md)");
    expect(history[1]?.content).toContain("[Previous page](/log-000001.md)");
    expect(history.at(-1)?.content).not.toContain("Next page");
    expect(history.every((file) => Buffer.byteLength(file.content, "utf8") <= 2_048)).toBe(true);
  });

  it("keeps history rendering bounded for a 100,000-concept publication", () => {
    const baselineRssBytes = process.memoryUsage().rss;
    const files = renderLogFiles(
      [],
      100_000,
      "2026-07-13T00:00:00.000Z",
      { maxEntries: 100, maxBytes: 65_536 },
      {
        entries: Array.from({ length: 100 }, (_, index) => ({
          occurredAt: new Date(Date.UTC(2026, 5, 30, 23, 59, 0, index)).toISOString(),
          action: "Update",
          message: `Retained bounded publication event ${index + 1}.`,
          changedFileCount: 100_000
        })),
        summaries: Array.from({ length: 24 }, (_, index) => ({
          month: `2024-${String(12 - (index % 12)).padStart(2, "0")}`,
          publicationCount: 10,
          changedFileCount: 1_000_000
        }))
      },
      { created: 100_000, updated: 0, moved: 0, deleted: 0, affectedDirectories: [] }
    );
    const peakRssBytes = process.memoryUsage().rss;

    expect(files[0]?.content).toContain("Published 100000 Markdown pages.");
    expect(files).toHaveLength(2);
    expect(files.every((file) => Buffer.byteLength(file.content, "utf8") <= 65_536)).toBe(true);
    expect(peakRssBytes - baselineRssBytes).toBeLessThan(64 * 1024 * 1024);
  });
});
