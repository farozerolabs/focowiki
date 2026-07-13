import type { RuntimeConfig } from "../config.js";
import type { RuntimeSettingsService } from "./service.js";
import type { RuntimeUploadGenerationSettings } from "./types.js";
import { sanitizeUploadGenerationSettings } from "./validation.js";

export async function resolveUploadGenerationSettings(input: {
  config: RuntimeConfig;
  runtimeSettings?: RuntimeSettingsService | null;
}): Promise<RuntimeUploadGenerationSettings> {
  return (
    (await input.runtimeSettings?.getSnapshot())?.uploadGeneration ??
    sanitizeUploadGenerationSettings(input.config.upload)
  );
}
