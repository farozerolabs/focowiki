import type { DatabaseClient } from "../../db/client.js";
import { totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";
import { buildDocumentPublicationJob } from
  "../application/document-publication-job-builder.js";
import type { DocumentPublicationJob } from
  "../application/document-publication-job-ports.js";
import {
  hasDocumentPublicationMemoryHeadroom,
  resolveDocumentPublicationConcurrency
} from
  "../application/document-resource-capacity.js";
import { DOCUMENT_PUBLICATION_HEARTBEAT_MILLISECONDS } from
  "../domain/document-publication-job.js";
import { DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION } from
  "../application/document-publication-renderer-contract.js";
import { selectDocumentPublicationObjectMetrics } from
  "../application/document-publication-object-metrics.js";
import { createDocumentPublicationRuntimeFailureReporter } from
  "../application/document-publication-runtime-failure-reporter.js";
import type { DocumentWorkerObservability } from
  "../application/document-worker-observability.js";
import { createPostgresDocumentPublicationActivation } from
  "./postgres-document-publication-activation.js";
import { createPostgresDocumentPublicationJobRepository } from
  "./postgres-document-publication-job-repository.js";
import { readPublicationJobFactDeltas } from
  "./postgres-document-publication-job-deltas.js";
import {
  readPostgresDocumentPublicationBaseEventTime,
  readPostgresDocumentPublicationJobBasePages
} from
  "./postgres-document-publication-job-base-pages.js";
import type { createProductionDocumentScopeRenderer } from
  "./production-document-scope-renderer.js";
import { safeErrorCode } from "./production-document-error-diagnostic.js";
import { waitForDocumentWork } from
  "./production-document-fixed-runtime-support.js";

export function createProductionDocumentPublicationJobRuntime(input: {
  sql: DatabaseClient;
  workerId: string;
  maximumConcurrency: number;
  renderer: ReturnType<typeof createProductionDocumentScopeRenderer>;
  observability?: Pick<
    DocumentWorkerObservability,
    "publication" | "publicationRuntime"
  >;
}) {
  const repository = createPostgresDocumentPublicationJobRepository(input.sql);
  const activation = createPostgresDocumentPublicationActivation({
    sql: input.sql
  });
  const workerId = `${input.workerId}:publication-job`;
  let maximumActiveScopes = validateConcurrency(input.maximumConcurrency);
  const active = new Set<Promise<void>>();
  const runtimeFailureReporter =
    createDocumentPublicationRuntimeFailureReporter({
      emit: (event) => input.observability?.publicationRuntime(event)
    });

  async function run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let claimed = false;
      try {
        if (!publicationMemoryHeadroom()) {
          await waitForDocumentWork(100, signal);
          continue;
        }
        const concurrency = resolveDocumentPublicationConcurrency(
          maximumActiveScopes
        );
        await admitAvailable(Math.max(0,
          concurrency.jobConcurrency - active.size));
        while (!signal.aborted
          && active.size < concurrency.jobConcurrency) {
          const job = await repository.claimOne({
            workerId
          });
          if (!job) break;
          claimed = true;
          track(job, signal);
        }
        runtimeFailureReporter.recovered();
      } catch (error) {
        runtimeFailureReporter.failed(safeErrorCode(error));
        await waitForDocumentWork(250, signal);
        continue;
      }
      if (!claimed) await waitForDocumentWork(50, signal);
    }
    await Promise.allSettled(active);
  }

  function track(job: DocumentPublicationJob, signal: AbortSignal): void {
    const startedAt = Date.now();
    let tracked: Promise<void>;
    tracked = execute(job, signal)
      .catch((error) => observe("failed", job, startedAt,
        safeErrorCode(error), zeroObjectMetrics()))
      .finally(() => active.delete(tracked));
    active.add(tracked);
  }

  async function admitAvailable(limit: number): Promise<void> {
    for (let index = 0; index < limit; index += 1) {
      const admitted = await repository.admitOne({
        rendererContractVersion:
          DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION
      });
      if (!admitted) break;
    }
  }

  async function execute(
    job: DocumentPublicationJob,
    signal: AbortSignal
  ): Promise<void> {
    const startedAt = Date.now();
    const attemptToken = requireAttemptToken(job);
    const attemptController = new AbortController();
    const attemptSignal = AbortSignal.any([signal, attemptController.signal]);
    let leaseFailure: unknown = null;
    const heartbeat = maintainAttemptLease({
      repository,
      jobPublicId: job.publicId,
      attemptToken,
      signal: attemptSignal
    }).catch((error) => {
      leaseFailure = error;
      attemptController.abort(error);
    });
    observe("claimed", job, startedAt, null, zeroObjectMetrics());
    let executionError: unknown = null;
    try {
      const documents = await readPublicationJobFactDeltas(input.sql,
        job.publicId);
      const baseDeterministicChangedAt =
        await readPostgresDocumentPublicationBaseEventTime(input.sql, {
          knowledgeBaseId: job.knowledgeBaseId,
          baseActiveRevision: job.baseActiveRevision
        });
      const built = await buildDocumentPublicationJob({
        jobPublicId: job.publicId,
        knowledgeBaseId: job.knowledgeBaseId,
        baseActiveRevision: job.baseActiveRevision,
        baseDeterministicChangedAt,
        targetReadinessSequence: job.targetReadinessSequence,
        rendererContractVersion: job.rendererContractVersion,
        deterministicChangedAt: job.deterministicEventTime,
        documents,
        signal: attemptSignal,
        maximumConcurrency: resolveDocumentPublicationConcurrency(
          maximumActiveScopes
        ).scopeConcurrencyPerJob,
        checkpoint: () => assertCurrentAttempt(job.publicId, attemptToken),
        render: (scope, options, renderSignal) => input.renderer.render(
          scope,
          renderSignal,
          options
        ),
        readObjectMetadata: (objectIds) => readObjectMetadata(
          input.sql, objectIds
        ),
        readBasePages: (scope) => readPostgresDocumentPublicationJobBasePages(
          input.sql, scope
        )
      });
      const persisted = await repository.persistManifest({
        jobPublicId: job.publicId,
        attemptToken,
        fingerprintSha256: built.fingerprintSha256,
        outputs: built.outputs
      });
      if (!persisted) throw runtimeError("publication_attempt_fenced");
      observe("manifest_persisted", job, startedAt, null,
        selectDocumentPublicationObjectMetrics(built));
      await activation.activate({
        jobPublicId: job.publicId,
        attemptToken
      });
      observe("activated", job, startedAt, null,
        selectDocumentPublicationObjectMetrics(built));
    } catch (error) {
      executionError = leaseFailure ?? error;
    } finally {
      attemptController.abort();
      await heartbeat;
    }
    if (executionError !== null) {
      const current = await repository.readJob(job.publicId);
      if (current?.outcome === "committed") return;
      if (signal.aborted) {
        await repository.releaseAttempt({
          jobPublicId: job.publicId,
          attemptToken
        });
        observe("retrying", job, startedAt, "worker_shutdown",
          zeroObjectMetrics());
        return;
      }
      const code = safeErrorCode(executionError);
      const result = await repository.failAttempt({
        jobPublicId: job.publicId,
        attemptToken,
        errorCode: code,
        retryable: retryablePublicationError(code)
      });
      observe(result === "retrying" ? "retrying" : "failed",
        job, startedAt, code, zeroObjectMetrics());
    }
  }

  function observe(
    event: "claimed" | "manifest_persisted" | "activated"
      | "retrying" | "failed",
    job: DocumentPublicationJob,
    startedAt: number,
    errorCode: string | null,
    objectMetrics: Readonly<{
      objectPutCount: number;
      objectReuseCount: number;
      objectRequestCount: number;
      objectAttemptedBytes: number;
      peakActiveScopeCount: number;
    }>
  ): void {
    const memory = process.memoryUsage();
    const heapLimitBytes = getHeapStatistics().heap_size_limit;
    input.observability?.publication({
      event,
      knowledgeBaseId: job.knowledgeBaseId,
      jobPublicId: job.publicId,
      itemCount: job.items.length,
      attemptCount: job.attemptCount,
      durationMs: Math.max(0, Date.now() - startedAt),
      ...objectMetrics,
      heapUsedBytes: memory.heapUsed,
      heapLimitBytes,
      rssBytes: memory.rss,
      errorCode
    });
  }

  async function assertCurrentAttempt(
    jobPublicId: string,
    attemptToken: string
  ): Promise<void> {
    const current = await repository.readJob(jobPublicId);
    if (!current || current.outcome !== "pending"
      || current.attemptToken !== attemptToken
      || !current.attemptDeadline
      || Date.parse(current.attemptDeadline) <= Date.now()) {
      throw runtimeError("publication_attempt_fenced");
    }
  }

  return {
    run,
    updateMaximumConcurrency(value: number) {
      maximumActiveScopes = validateConcurrency(value);
    },
    activeCount() {
      return active.size;
    }
  };
}

async function maintainAttemptLease(input: {
  repository: ReturnType<typeof createPostgresDocumentPublicationJobRepository>;
  jobPublicId: string;
  attemptToken: string;
  signal: AbortSignal;
}): Promise<void> {
  while (!input.signal.aborted) {
    await waitForDocumentWork(
      DOCUMENT_PUBLICATION_HEARTBEAT_MILLISECONDS,
      input.signal
    );
    if (input.signal.aborted) return;
    const deadline = await input.repository.renewAttempt({
      jobPublicId: input.jobPublicId,
      attemptToken: input.attemptToken
    });
    if (!deadline) throw runtimeError("publication_attempt_fenced");
  }
}

function publicationMemoryHeadroom(): boolean {
  const memory = process.memoryUsage();
  const heapLimitBytes = getHeapStatistics().heap_size_limit;
  const constrainedMemory = process.constrainedMemory?.() ?? 0;
  const residentLimitBytes = constrainedMemory > 0
    ? Math.min(totalmem(), constrainedMemory) : totalmem();
  return hasDocumentPublicationMemoryHeadroom({
    heapUsedBytes: memory.heapUsed,
    heapLimitBytes,
    rssBytes: memory.rss,
    residentLimitBytes
  });
}

function zeroObjectMetrics() {
  return {
    objectPutCount: 0,
    objectReuseCount: 0,
    objectRequestCount: 0,
    objectAttemptedBytes: 0,
    peakActiveScopeCount: 0
  } as const;
}

async function readObjectMetadata(
  sql: DatabaseClient,
  objectIds: readonly string[]
): Promise<readonly Readonly<{ objectId: string; contentType: string }>[]> {
  if (objectIds.length === 0) return [];
  const rows = await sql<Array<{
    object_id: string;
    content_type: string;
  }>>`
    SELECT object_id, content_type
    FROM focowiki.object_registrations
    WHERE object_id IN ${sql(objectIds)} AND state = 'verified'
    ORDER BY object_id COLLATE "C"
  `;
  return rows.map((row) => ({
    objectId: row.object_id,
    contentType: row.content_type
  }));
}

function retryablePublicationError(code: string): boolean {
  return ![
    "publication_job_item_limit_invalid",
    "publication_job_knowledge_base_mismatch",
    "publication_output_path_conflict",
    "publication_output_manifest_empty",
    "publication_dependency_missing",
    "publication_navigation_output_missing",
    "publication_object_metadata_missing",
    "publication_manifest_unverified",
    "publication_renderer_contract_mismatch",
    "publication_search_receipts_incomplete",
    "publication_active_base_changed",
    "publication_source_precondition_failed",
    "publication_work_precondition_failed"
  ].includes(code);
}

function requireAttemptToken(job: DocumentPublicationJob): string {
  if (!job.attemptToken) throw runtimeError("publication_attempt_token_missing");
  return job.attemptToken;
}

function validateConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw runtimeError("publication_job_concurrency_invalid");
  }
  return value;
}

function runtimeError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Publication job runtime error: ${code}`), {
    code
  });
}
