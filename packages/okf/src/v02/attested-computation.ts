import type {
  OkfAttestedComputation,
  OkfComputationParameter,
  OkfDiagnostic,
  OkfOwnership
} from "./types.js";

const MAX_PARAMETERS = 128;

export function analyzeOkfAttestedComputation(input: {
  metadata: Record<string, unknown>;
  ownership: OkfOwnership;
  markdownBody?: string;
  candidatePaths?: readonly string[];
}): {
  contract: OkfAttestedComputation | null;
  diagnostics: OkfDiagnostic[];
} {
  if (input.metadata.type !== "Attested Computation") {
    return { contract: null, diagnostics: [] };
  }
  const diagnostics: OkfDiagnostic[] = [];
  const runtime = readString(input.metadata.runtime);
  if (runtime === null) diagnostics.push(diagnostic(input.ownership, "runtime", "okf.computation.runtime_invalid"));

  const parameters = normalizeParameters(input.metadata.parameters);
  if (parameters === null) {
    diagnostics.push(diagnostic(input.ownership, "parameters", "okf.computation.parameters_invalid"));
  }

  const computation = normalizeComputation(input.metadata.computation, input.markdownBody);
  if (computation === null) {
    diagnostics.push(diagnostic(input.ownership, "computation", "okf.computation.definition_invalid"));
  }
  const executor = normalizeExecutor(input.metadata.executor);
  if (executor === null) {
    diagnostics.push(diagnostic(input.ownership, "executor", "okf.computation.executor_invalid"));
  }
  const attester = normalizeAttester(input.metadata.attester);
  if (attester === null) {
    diagnostics.push(diagnostic(input.ownership, "attester", "okf.computation.attester_invalid"));
  }

  let resourcesAvailable = true;
  for (const [path, resource] of [
    ["computation", computation?.kind === "resource" ? computation.resource : null],
    ["executor.resource", executor?.resource ?? null],
    ["attester.resource", attester?.resource ?? null]
  ] as const) {
    if (
      resource !== null
      && isLocalResource(resource)
      && input.candidatePaths !== undefined
      && !input.candidatePaths.includes(resource)
    ) {
      diagnostics.push(diagnostic(input.ownership, path, "okf.computation.local_target_missing"));
      resourcesAvailable = false;
    }
  }

  const complete = runtime !== null
    && parameters !== null
    && computation !== null
    && executor !== null
    && attester !== null
    && resourcesAvailable;
  return {
    contract: {
      complete,
      runtime,
      parameters: parameters ?? [],
      computation,
      executor,
      attester
    },
    diagnostics
  };
}

function normalizeParameters(value: unknown): OkfComputationParameter[] | null {
  if (!Array.isArray(value) || value.length > MAX_PARAMETERS) return null;
  const parameters: OkfComputationParameter[] = [];
  const names = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) return null;
    const name = readString(item.name);
    const type = readString(item.type);
    if (name === null || type === null || typeof item.required !== "boolean" || names.has(name)) {
      return null;
    }
    names.add(name);
    parameters.push({ name, type, required: item.required });
  }
  return parameters;
}

function normalizeComputation(
  value: unknown,
  markdownBody: string | undefined
): OkfAttestedComputation["computation"] {
  if (value !== undefined) {
    const resource = readResource(value);
    return resource === null ? null : { kind: "resource", resource };
  }
  if (markdownBody === undefined) return null;
  const heading = /^# Computation\s*$/mu.exec(markdownBody);
  if (!heading || heading.index === undefined) return null;
  const tail = markdownBody.slice(heading.index + heading[0].length);
  const nextHeading = /^#\s+/mu.exec(tail);
  const section = nextHeading?.index === undefined ? tail : tail.slice(0, nextHeading.index);
  const blocks = Array.from(section.matchAll(/```[^\n]*\n[\s\S]*?```/gu));
  return blocks.length === 1 ? { kind: "inline", resource: null } : null;
}

function normalizeExecutor(value: unknown): OkfAttestedComputation["executor"] {
  if (!isRecord(value)) return null;
  const resource = readResource(value.resource);
  const receipt = value.receipt === undefined
    ? []
    : Array.isArray(value.receipt)
      ? value.receipt.filter((item): item is string => typeof item === "string" && item.length > 0)
      : null;
  const expectedReceiptLength = Array.isArray(value.receipt) ? value.receipt.length : 0;
  return resource !== null && receipt !== null && receipt.length === expectedReceiptLength
    ? { resource, receipt }
    : null;
}

function normalizeAttester(value: unknown): OkfAttestedComputation["attester"] {
  if (!isRecord(value)) return null;
  const resource = readResource(value.resource);
  return resource === null ? null : { resource };
}

function readResource(value: unknown): string | null {
  const resource = readString(value);
  if (resource === null || resource.includes("\\") || resource.includes("\0")) return null;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(resource)) return resource;
  if (resource.startsWith("/") || resource.split("/").some((part) => part === "..")) return null;
  return resource;
}

function isLocalResource(value: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/iu.test(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnostic(
  ownership: OkfOwnership,
  path: string,
  messageKey: string
): OkfDiagnostic {
  return {
    ruleId: "OKF-0.2-ATTESTED-COMPUTATION",
    classification: "normative",
    disposition: ownership === "focowiki" ? "blocking" : "advisory",
    path,
    messageKey
  };
}
