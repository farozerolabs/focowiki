import { describe, expect, it } from "vitest";
import { resources } from "../src/i18n/resources";

describe("Admin source processing translations", () => {
  it.each(["en-US", "zh-CN"] as const)("uses current generation stages in %s", (locale) => {
    const translation = resources[locale].translation;

    expect(translation.tasks.phase).toMatchObject({
      uploadStorage: expect.any(String),
      metadataResolution: expect.any(String),
      llmSuggestion: expect.any(String),
      graphGeneration: expect.any(String),
      projectionGeneration: expect.any(String),
      generationValidation: expect.any(String),
      generationActivation: expect.any(String)
    });
    expect(translation.tasks.phase).not.toHaveProperty("bundleGeneration");
    expect(translation.tasks.phase).not.toHaveProperty("indexPublication");
    expect(translation.tasks.phase).not.toHaveProperty("releaseActivation");
    expect(translation.detail).not.toHaveProperty("releases");
    expect(translation.detail).not.toHaveProperty("bundleFiles");
    expect(translation).not.toHaveProperty("generation");
  });
});
