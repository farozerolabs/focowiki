export const STORAGE_VNEXT_FULL_LIVE_FLOW_KINDS = Object.freeze([
  "positive",
  "inverse",
  "failure",
  "interleaved",
  "security",
  "admin",
  "openapi",
  "generated",
  "search",
  "graph",
  "deletion"
]);

const FULL_FILE_COUNT = 29_736;

export function createStorageVnextFullLiveFlowUploadKey(input) {
  if (
    !/^svnext-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/u.test(input?.runId ?? "")
    || !/^source-file-[0-9a-f-]{36}$/u.test(input?.sourceFileId ?? "")
  ) {
    throw new Error("Storage vNext full live-flow upload identity is invalid");
  }
  return `${input.runId}-full-delete-restore-${input.sourceFileId}`;
}

export function assertStorageVnextFullLiveFlowEvidence(input) {
  if (
    !/^svnext-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/u.test(input?.runId ?? "")
    || !/^knowledge-base-[0-9a-f-]{36}$/u.test(input?.knowledgeBaseId ?? "")
  ) reject("scope identity is invalid");
  for (const field of [
    "initialSourceCount",
    "finalSourceCount",
    "finalChecksumMismatchCount",
    "finalPathMismatchCount",
    "terminalWorkItems",
    "liveCandidates",
    "activeSnapshots"
  ]) {
    if (!Number.isSafeInteger(input[field]) || input[field] < 0) {
      reject(`${field} is invalid`);
    }
  }
  if (
    input.initialSourceCount !== FULL_FILE_COUNT
    || input.finalSourceCount !== FULL_FILE_COUNT
    || input.finalChecksumMismatchCount !== 0
    || input.finalPathMismatchCount !== 0
  ) reject("the full corpus was not restored exactly");
  if (
    input.terminalWorkItems !== 0
    || input.liveCandidates !== 0
    || input.activeSnapshots !== 1
  ) reject("live work or release state did not converge");
  if (input.controlsUnchanged !== true) reject("a pre-existing control scope changed");
  const flows = Array.isArray(input.flows) ? input.flows : [];
  const byKind = new Map(flows.map((flow) => [flow.kind, flow]));
  if (
    flows.length !== STORAGE_VNEXT_FULL_LIVE_FLOW_KINDS.length
    || byKind.size !== flows.length
    || STORAGE_VNEXT_FULL_LIVE_FLOW_KINDS.some((kind) => byKind.get(kind)?.passed !== true)
  ) reject("the representative flow matrix is incomplete");
  return Object.freeze({
    flowCount: flows.length,
    fullCorpusRestored: true,
    terminalConvergence: true,
    preexistingControlsUnchanged: true
  });
}

function reject(reason) {
  throw new Error(`Storage vNext full live-flow evidence failed: ${reason}`);
}
