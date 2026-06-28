import type { RuntimeConfig } from "../config.js";
import type { RuntimeSettingsService } from "./service.js";
import type { RuntimeUploadGenerationSettings } from "./types.js";

export async function resolveUploadGenerationSettings(input: {
  config: RuntimeConfig;
  runtimeSettings?: RuntimeSettingsService | null;
}): Promise<RuntimeUploadGenerationSettings> {
  return (await input.runtimeSettings?.getSnapshot())?.uploadGeneration ?? input.config.upload;
}
