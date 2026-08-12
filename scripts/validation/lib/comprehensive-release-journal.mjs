import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const RUN_ID_PATTERN = /^validation-\d{14}-[a-f0-9]{8}$/u;
const REQUIRED_FINGERPRINTS = Object.freeze([
  "application",
  "corpus",
  "model",
  "provider",
  "settings",
  "docker",
  "artifactContract"
]);

export async function createComprehensiveRunJournal(input) {
  assertRunId(input.runId);
  assertJournalPath(input.journalPath, input.runId);
  assertFingerprints(input.fingerprints);
  assertPhaseDefinitions(input.phases);
  const state = {
    schemaVersion: 1,
    owner: "focowiki",
    runId: input.runId,
    phases: structuredClone(input.phases),
    completedPhases: [],
    failures: [],
    fixes: [],
    cleanupOwners: [],
    revisions: [{
      id: 1,
      fingerprints: structuredClone(input.fingerprints),
      fingerprintHash: hash(input.fingerprints)
    }]
  };
  await writeJournal(input.journalPath, state);
  return createController(input.journalPath, state);
}

export async function openComprehensiveRunJournal({ journalPath, runId }) {
  assertJournalPath(journalPath, runId);
  const state = JSON.parse(await fs.readFile(journalPath, "utf8"));
  if (state.schemaVersion !== 1 || state.owner !== "focowiki") {
    throw new Error("Unsupported comprehensive journal schema");
  }
  if (state.runId !== runId) throw new Error("Comprehensive journal run identity mismatch");
  assertRunId(state.runId);
  for (const revision of state.revisions ?? []) {
    assertFingerprints(revision.fingerprints);
    if (revision.fingerprintHash !== hash(revision.fingerprints)) {
      throw new Error("Comprehensive journal fingerprint revision was mutated");
    }
  }
  assertPhaseDefinitions(state.phases);
  return createController(journalPath, state);
}

export function resolveComprehensiveResume(state, currentFingerprints) {
  assertFingerprints(currentFingerprints);
  const previous = state.revisions.at(-1)?.fingerprints;
  assertFingerprints(previous);
  const invalidatedPhaseIds = [];
  const reusableExternalPhaseIds = [];
  const completedById = new Map(state.completedPhases.map((phase) => [phase.id, phase]));

  for (const phase of state.phases) {
    const changed = phase.fingerprintKeys.some((key) => previous[key] !== currentFingerprints[key]);
    if (changed) invalidatedPhaseIds.push(phase.id);
    const completed = completedById.get(phase.id);
    if (
      completed?.reusableExternalArtifact
      && !changed
      && HASH_PATTERN.test(String(completed.verificationHash ?? ""))
    ) {
      reusableExternalPhaseIds.push(phase.id);
    }
  }

  return { invalidatedPhaseIds, reusableExternalPhaseIds };
}

function createController(journalPath, state) {
  return {
    state,
    async completePhase(id, completedItemIds, evidenceHash, options = {}) {
      const phase = state.phases.find((candidate) => candidate.id === id);
      if (!phase) throw new Error(`Unknown comprehensive phase: ${id}`);
      const completedIds = uniqueIds(completedItemIds, "completed item");
      if (!sameIds(phase.expectedItemIds, completedIds)) {
        throw new Error(`Phase completed item cardinality mismatch: ${id}`);
      }
      if (!HASH_PATTERN.test(String(evidenceHash))) throw new Error("Phase evidence hash is invalid");
      const completed = new Set(state.completedPhases.map((candidate) => candidate.id));
      const missingPrerequisites = phase.prerequisites.filter((prerequisite) => !completed.has(prerequisite));
      if (missingPrerequisites.length > 0) {
        throw new Error(`Phase prerequisites are incomplete: ${missingPrerequisites.join(", ")}`);
      }
      if (completed.has(id)) throw new Error(`Phase is already complete: ${id}`);
      state.completedPhases.push({
        id,
        completedItemIds: completedIds,
        evidenceHash,
        reusableExternalArtifact: options.reusableExternalArtifact === true,
        verificationHash: options.verificationHash ?? null
      });
      await writeJournal(journalPath, state);
    },
    async registerCleanup(resource) {
      if (!String(resource?.id ?? "").includes(state.runId)) {
        throw new Error("Cleanup owner is outside the comprehensive run");
      }
      const identity = `${resource.kind}:${resource.id}`;
      if (state.cleanupOwners.some((candidate) => `${candidate.kind}:${candidate.id}` === identity)) {
        throw new Error(`Duplicate cleanup owner: ${identity}`);
      }
      state.cleanupOwners.push({ kind: resource.kind, id: resource.id });
      await writeJournal(journalPath, state);
    },
    async recordFailure(failure) {
      if (!failure?.id || !failure?.phaseId || !HASH_PATTERN.test(String(failure.evidenceHash))) {
        throw new Error("Failure record is incomplete");
      }
      state.failures.push(structuredClone(failure));
      await writeJournal(journalPath, state);
    },
    async recordFix(fix) {
      if (!fix?.id || !HASH_PATTERN.test(String(fix.evidenceHash))) {
        throw new Error("Fix record is incomplete");
      }
      const requested = uniqueIds(fix.invalidatedPhaseIds, "invalidated phase");
      const invalidated = expandDownstreamPhases(state.phases, requested);
      state.completedPhases = state.completedPhases.filter((phase) => !invalidated.has(phase.id));
      state.fixes.push({
        id: fix.id,
        evidenceHash: fix.evidenceHash,
        invalidatedPhaseIds: [...invalidated].sort()
      });
      await writeJournal(journalPath, state);
    }
  };
}

async function writeJournal(journalPath, state) {
  await fs.mkdir(path.dirname(journalPath), { recursive: true });
  const temporaryPath = `${journalPath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, journalPath);
}

function assertPhaseDefinitions(phases) {
  const ids = uniqueIds(phases, "phase");
  const known = new Set(ids);
  for (const phase of phases) {
    if (!Array.isArray(phase.prerequisites) || !Array.isArray(phase.fingerprintKeys)) {
      throw new Error(`Phase definition is incomplete: ${phase.id}`);
    }
    const expectedItemIds = uniqueIds(phase.expectedItemIds, `expected item for ${phase.id}`);
    if (expectedItemIds.length === 0) throw new Error(`Phase expected item set is empty: ${phase.id}`);
    if (phase.prerequisites.some((id) => !known.has(id))) {
      throw new Error(`Phase prerequisite is unknown: ${phase.id}`);
    }
    if (phase.fingerprintKeys.some((key) => !REQUIRED_FINGERPRINTS.includes(key))) {
      throw new Error(`Phase fingerprint dependency is unknown: ${phase.id}`);
    }
  }
}

function expandDownstreamPhases(phases, initialIds) {
  const known = new Set(phases.map((phase) => phase.id));
  if (initialIds.some((id) => !known.has(id))) throw new Error("Fix invalidates an unknown phase");
  const invalidated = new Set(initialIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const phase of phases) {
      if (!invalidated.has(phase.id) && phase.prerequisites.some((id) => invalidated.has(id))) {
        invalidated.add(phase.id);
        changed = true;
      }
    }
  }
  return invalidated;
}

function assertFingerprints(fingerprints) {
  for (const key of REQUIRED_FINGERPRINTS) {
    if (!HASH_PATTERN.test(String(fingerprints?.[key] ?? ""))) {
      throw new Error(`Comprehensive ${key} fingerprint is invalid`);
    }
  }
}

function assertRunId(runId) {
  if (!RUN_ID_PATTERN.test(String(runId))) throw new Error("Comprehensive run ID is invalid");
}

function assertJournalPath(journalPath, runId) {
  const absolute = path.resolve(String(journalPath ?? ""));
  const normalized = absolute.split(path.sep).join("/");
  const repositoryEvidence = `/ReferenceDocs/validation/comprehensive-large-scale-release/${runId}/`;
  const temporaryEvidence = `${path.resolve(os.tmpdir()).split(path.sep).join("/")}/`;
  if (
    (!normalized.includes(repositoryEvidence) && !normalized.startsWith(temporaryEvidence))
    || !normalized.includes(`/${runId}/`)
  ) {
    throw new Error("Comprehensive journal path is outside run-owned ignored evidence storage");
  }
}

function uniqueIds(items, label) {
  if (!Array.isArray(items)) throw new Error(`${label} identities are missing`);
  const ids = items.map((item) => typeof item === "string" ? item : String(item?.id ?? ""));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error(`${label} identities are invalid`);
  }
  return ids;
}

function sameIds(expected, actual) {
  if (expected.length !== actual.length) return false;
  const actualSet = new Set(actual);
  return expected.every((id) => actualSet.has(id));
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
