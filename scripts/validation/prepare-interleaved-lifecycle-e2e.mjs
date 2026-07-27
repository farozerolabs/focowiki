import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import {
  buildInterleavedBaselineSnapshot
} from "./lib/interleaved-baseline.mjs";
import {
  buildInterleavedBoundaryCorpus
} from "./lib/interleaved-boundary-corpus.mjs";
import {
  createEvidenceRedactor
} from "./lib/interleaved-evidence-redaction.mjs";
import {
  buildInterleavedCorpusManifest
} from "./lib/interleaved-lifecycle-corpus.mjs";
import {
  createInterleavedLifecycleController,
  createValidationRunId
} from "./lib/interleaved-lifecycle-controller.mjs";
import {
  buildDirectedPairwiseMatrix,
  buildFourLifecyclePermutations,
  buildThreeLifecyclePermutations
} from "./lib/interleaved-lifecycle-matrix.mjs";
import {
  createInterleavedPostgresEvidence
} from "./lib/interleaved-postgres-evidence.mjs";
import {
  createInterleavedRedisEvidence
} from "./lib/interleaved-redis-evidence.mjs";
import { selectSamples } from "./lib/sample-selector.mjs";

loadLocalEnv();

const runId = process.env.FOCOWIKI_INTERLEAVED_RUN_ID || createValidationRunId();
const reportRoot = path.resolve(
  "ReferenceDocs",
  "validate-interleaved-lifecycle-e2e"
);
const controller = createInterleavedLifecycleController({
  runId,
  seed: process.env.FOCOWIKI_INTERLEAVED_SEED || runId,
  reportRoot
});
await controller.initialize();

const sourceDir = requiredEnv("FOCOWIKI_VALIDATION_MARKDOWN_DIR");
const sampleCount = readSampleCount(
  process.env.FOCOWIKI_INTERLEAVED_SAMPLE_COUNT,
  200
);
const selection = selectSamples(sourceDir, sampleCount, {
  maxCandidateProfiles: Math.max(sampleCount * 32, 5_000)
});
const matrix = {
  pairwise: buildDirectedPairwiseMatrix(),
  threeWay: buildThreeLifecyclePermutations(),
  fourWay: buildFourLifecyclePermutations()
};
const scenarioIds = [
  "control-upload",
  "control-modification",
  "control-deletion",
  "control-maintenance",
  ...matrix.pairwise.map((scenario) => scenario.id),
  ...matrix.threeWay.map((scenario) => scenario.id),
  ...matrix.fourWay.map((scenario) => scenario.id),
  "repeat-and-conflict",
  "restart-and-recovery",
  "boundary-inputs",
  "manual-review"
];
const manifest = buildInterleavedCorpusManifest({
  runId,
  samples: selection.samples,
  scenarioIds
});
const boundaryCorpus = buildInterleavedBoundaryCorpus();

const redactor = createEvidenceRedactor(controller.state.seed);
const postgresEvidence = createInterleavedPostgresEvidence({
  databaseUrl: requiredEnv("DATABASE_URL")
});
const redisEvidence = createInterleavedRedisEvidence({
  redisUrl: requiredEnv("REDIS_URL")
});

try {
  const [postgres, redis, services] = await Promise.all([
    postgresEvidence.snapshotGlobal(),
    redisEvidence.snapshot({ redactor }),
    probeServices()
  ]);
  const baseline = buildInterleavedBaselineSnapshot({
    redactor,
    postgres,
    redis,
    services
  });

  writeJson(path.join(controller.state.evidenceDir, "before-state.json"), baseline);
  writeJson(path.join(controller.state.evidenceDir, "corpus-manifest.json"), manifest);
  writeJson(
    path.join(controller.state.evidenceDir, "boundary-corpus.json"),
    boundaryCorpus
  );
  writeJson(path.join(controller.state.evidenceDir, "scenario-matrix.json"), {
    kind: "focowiki-interleaved-lifecycle-matrix",
    runId,
    ...matrix
  });

  controller.state.baseline = {
    captured: true,
    repositoryChecksPassed:
      controller.state.baseline?.repositoryChecksPassed === true,
    sampleCount: manifest.sampleCount,
    scenarioCount: scenarioIds.length,
    coverage: selection.coverage,
    coverageWarnings: selection.coverageWarnings
  };
  await controller.persist();
} finally {
  await Promise.allSettled([
    postgresEvidence.close(),
    redisEvidence.close()
  ]);
}

process.stdout.write(`${JSON.stringify({
  runId,
  evidenceDir: controller.state.evidenceDir,
  sampleCount: manifest.sampleCount,
  scenarioCount: scenarioIds.length,
  baselineCaptured: true
}, null, 2)}\n`);

function loadLocalEnv() {
  const envPath = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envPath)) loadEnvFile(envPath);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function readSampleCount(value, fallback) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 14 || parsed > 200) {
    throw new Error("FOCOWIKI_INTERLEAVED_SAMPLE_COUNT must be between 14 and 200.");
  }
  return parsed;
}

async function probeServices() {
  return Promise.all([
    probe("admin-api", `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}/healthz`),
    probe("developer-openapi", `http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT || "43200"}/healthz`),
    Promise.resolve({ name: "postgres", state: "healthy" }),
    Promise.resolve({ name: "redis", state: "healthy" })
  ]);
}

async function probe(name, url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(1_000)
    });
    return { name, state: response.ok ? "healthy" : "unhealthy" };
  } catch {
    return { name, state: "stopped" };
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  });
}
