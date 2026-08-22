import type { createDocumentResourcePermits } from
  "../application/document-resource-permits.js";
import type { WeightedGenerationTaskRunner } from
  "../application/weighted-generation-task-runner.js";
import { modelEvaluationError } from
  "./document-model-evaluation-validation.js";

export function runDocumentGeneration<TResult>(
  input: {
    permits?: ReturnType<typeof createDocumentResourcePermits>;
    generation?: WeightedGenerationTaskRunner;
  },
  workClass: "first_layer" | "candidate_delta",
  operation: () => Promise<TResult>,
  options: {
    signal?: AbortSignal;
    ownerKey?: string;
    onMetric(metric: { waitTimeMs: number; serviceTimeMs: number }): void;
    classifyResult?(result: TResult): "success" | "failure" | "rate_limited" | "timeout";
  }
): Promise<TResult> {
  if (input.generation) {
    return input.generation.run(workClass, operation, options);
  }
  if (input.permits) {
    return input.permits.run("generation_model", operation, options);
  }
  throw modelEvaluationError("MODEL_GENERATION_RUNNER_MISSING");
}

export function classifyDocumentGenerationResult<TResult extends {
  warnings: readonly string[];
}>(input: TResult): "success" | "failure" | "rate_limited" | "timeout" {
  if (input.warnings.length === 0) return "success";
  const diagnostic = input.warnings.join("\n").toLowerCase();
  if (/(?:429|rate limit|too many requests|throttl)/u.test(diagnostic)) {
    return "rate_limited";
  }
  if (/(?:timeout|timed out|deadline)/u.test(diagnostic)) return "timeout";
  return "failure";
}
