import { decryptRuntimeSecret } from "../../runtime-settings/encryption.js";
import type { RuntimeModelConfigPrivate } from "../../runtime-settings/types.js";

export function unlockGenerationModelRevision(
  model: RuntimeModelConfigPrivate,
  deploymentSecret: string
): RuntimeModelConfigPrivate {
  return {
    ...model,
    apiKey: decryptRuntimeSecret({
      value: model.apiKey,
      secret: deploymentSecret
    })
  };
}
