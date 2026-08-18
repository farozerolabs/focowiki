import { describe, expect, it } from "vitest";
import { resources } from "../src/i18n/resources";

describe("Admin source processing translations", () => {
  it.each(["en-US", "zh-CN"] as const)("uses fixed document work kinds in %s", (locale) => {
    const translation = resources[locale].translation;

    expect(translation.tasks.workKind).toMatchObject({
      prepare: expect.any(String),
      firstLayer: expect.any(String),
      contentProjection: expect.any(String),
      graphrag: expect.any(String),
      relationReconcile: expect.any(String),
      knowledgeProjection: expect.any(String),
      activate: expect.any(String),
      cleanup: expect.any(String)
    });
    expect(translation.tasks.workKind).not.toHaveProperty("semantic");
    expect(translation.tasks.workKind).not.toHaveProperty("indexing");
    expect(translation.tasks.workKind).not.toHaveProperty("finalizing");
    expect(translation.detail).not.toHaveProperty("releases");
    expect(translation.detail).not.toHaveProperty("bundleFiles");
    expect(translation).not.toHaveProperty("generation");
  });

  it("uses embedding terminology throughout all Admin UI copy", () => {
    const englishCopy = JSON.stringify(resources["en-US"].translation);
    const chineseCopy = JSON.stringify(resources["zh-CN"].translation);

    expect(englishCopy).toContain("Embedding model");
    expect(englishCopy).toContain("Model configuration");
    expect(englishCopy).not.toMatch(/\bvectors?\b/iu);
    expect(chineseCopy).toContain("嵌入模型");
    expect(chineseCopy).toContain("模型配置");
    expect(chineseCopy).not.toContain("向量");
  });
});
