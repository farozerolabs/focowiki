import type { DocumentLeaseGeneration } from
  "../domain/document-publication-identifiers.js";
import { getHeapStatistics } from "node:v8";

export const DOCUMENT_PUBLICATION_SCOPE_EXECUTION_TIMEOUT_MS = 180_000;

export type DocumentPublicationImmutableScopeSnapshot = Readonly<{
  publicId: string;
  publicationGenerationPublicId: string;
  knowledgeBaseId: string;
  scopeIdentity: string;
  scopeKind: string;
  scopeKey: string;
  scopeGeneration: number;
  targetFactEpoch: number;
  inputSnapshotFingerprintSha256: string;
  rendererContractVersion: string;
  planningMode: "initial" | "delta" | "repair";
  affectedSourceFilePublicIds: readonly string[];
  deterministicChangedAt: string;
  baseGenerationPublicId: string | null;
  baseDeterministicChangedAt?: string | null;
  affectedLogicalPaths?: readonly string[];
  members: readonly Readonly<{
    kind: string;
    publicId: string;
    version: string;
    order: number;
    sourceFilePublicId: string | null;
  }>[];
  basePages: readonly Readonly<{
    logicalPath?: string;
    normalizedPath: string;
    action: "put" | "delete";
    entryKind: string | null;
    objectId: string | null;
    checksumSha256: string | null;
    byteCount: number | null;
    storageKey?: string | null;
    contentType?: string | null;
    objectFormat?: string | null;
  }>[];
}>;

type RenderedScopeOutput = Readonly<{
  outputFingerprintSha256: string;
  validationEvidence: Readonly<Record<string, unknown>>;
  pages: readonly Readonly<{
    logicalPath: string;
    normalizedPath: string;
    action: "put" | "delete";
    entryKind: string | null;
    objectId: string | null;
    checksumSha256: string | null;
    byteCount: number | null;
  }>[];
  navigationMutations: readonly Readonly<{
    directoryPath: string;
    order: number;
    action: "upsert" | "delete";
    mutation: Readonly<Record<string, unknown>>;
  }>[];
  verifiedReservations: readonly Readonly<{
    objectId: string;
    writeAttemptPublicId: string;
  }>[];
  storageRequests?: Readonly<{
    put: number;
    attemptedBytes: number;
  }>;
}>;

export function createDocumentPublicationScopeGenerationExecutor(input: {
  snapshots: {
    readScope(publicId: string):
      Promise<DocumentPublicationImmutableScopeSnapshot>;
  };
  outputs: {
    persistOutput(output: Readonly<{
      scopeGenerationPublicId: string;
      workerId: string;
      leaseGeneration: DocumentLeaseGeneration;
      checkedAt: string;
    }> & RenderedScopeOutput): Promise<void>;
  };
  leases?: {
    heartbeat(input: Readonly<{
      publicId: string;
      workerId: string;
      leaseGeneration: DocumentLeaseGeneration;
      now: string;
      leaseDurationMs: number;
    }>): Promise<boolean>;
  };
  heartbeatIntervalMs?: number;
  leaseDurationMs?: number;
  maximumExecutionMs?: number;
  supportedRendererContractVersion?: string;
  now?: () => string;
  render(
    snapshot: DocumentPublicationImmutableScopeSnapshot,
    signal: AbortSignal,
    checkpoint: () => Promise<void>
  ): Promise<RenderedScopeOutput>;
  onPersisted?(input: Readonly<{
    snapshot: DocumentPublicationImmutableScopeSnapshot;
    recordsRendered: number;
    objectPutCount: number;
    objectReuseCount: number;
    putByteCount: number;
    renewalCount: number;
    maximumHeartbeatAgeMs: number;
    heapUsedBytes: number;
    heapLimitBytes: number;
    rssBytes: number;
    changedRecordCount: number;
    chunkCount: number;
    peakBufferedRecordCount: number;
    touchedShardCount: number;
  }>): void;
  onStage?(input: Readonly<{
    snapshot: DocumentPublicationImmutableScopeSnapshot | null;
    scopeGenerationPublicId: string;
    stage: "snapshot_load" | "render" | "database_persist";
    outcome: "completed" | "failed";
    durationMs: number;
    errorCode: string | null;
    heapUsedBytes: number;
    heapLimitBytes: number;
    rssBytes: number;
  }>): void;
}) {
  const maximumExecutionMs = boundedExecutionMs(
    input.maximumExecutionMs ?? DOCUMENT_PUBLICATION_SCOPE_EXECUTION_TIMEOUT_MS
  );
  return {
    async execute(request: Readonly<{
      claim: Readonly<{
        publicId: string;
        leaseGeneration: DocumentLeaseGeneration;
      }>;
      workerId: string;
      checkedAt: string;
      signal: AbortSignal;
    }>): Promise<void> {
      const controller = new AbortController();
      const abort = () => controller.abort(request.signal.reason);
      request.signal.addEventListener("abort", abort, { once: true });
      const deadline = setTimeout(() => {
        controller.abort(runtimeError("scope_generation_deadline_exceeded"));
      }, maximumExecutionMs);
      deadline.unref?.();
      const heartbeatIntervalMs = input.heartbeatIntervalMs ?? 10_000;
      let nextHeartbeatAt = 0;
      let lastHeartbeatAt: number | null = null;
      let maximumHeartbeatAgeMs = 0;
      let renewalCount = 0;
      let renewal: Promise<void> | null = null;
      const heartbeat = async (force = false) => {
        if (!input.leases) return;
        const checkedAt = Date.now();
        if (!force && checkedAt < nextHeartbeatAt) return;
        if (renewal) return renewal;
        renewal = (async () => {
          const startedAt = Date.now();
          if (lastHeartbeatAt !== null) {
            maximumHeartbeatAgeMs = Math.max(
              maximumHeartbeatAgeMs, startedAt - lastHeartbeatAt
            );
          }
          const renewed = await input.leases!.heartbeat({
            publicId: request.claim.publicId,
            workerId: request.workerId,
            leaseGeneration: request.claim.leaseGeneration,
            now: input.now?.() ?? new Date().toISOString(),
            leaseDurationMs: input.leaseDurationMs ?? 30_000
          });
          if (!renewed) {
            const error = runtimeError("scope_generation_lease_lost");
            controller.abort(error);
            throw error;
          }
          lastHeartbeatAt = Date.now();
          nextHeartbeatAt = lastHeartbeatAt + heartbeatIntervalMs;
          renewalCount += 1;
        })();
        try {
          await renewal;
        } finally {
          renewal = null;
        }
      };
      let timer: ReturnType<typeof setInterval> | null = null;
      try {
        controller.signal.throwIfAborted();
        await heartbeat(true);
        if (input.leases) {
          timer = setInterval(() => void heartbeat().catch((error) => {
            controller.abort(error);
          }), heartbeatIntervalMs);
          timer.unref?.();
        }
        const snapshot = await observeStage({
          input,
          snapshot: null,
          scopeGenerationPublicId: request.claim.publicId,
          stage: "snapshot_load",
          signal: controller.signal,
          operation: () => input.snapshots.readScope(request.claim.publicId)
        });
        if (snapshot.publicId !== request.claim.publicId) {
          throw runtimeError("scope_generation_snapshot_identity_mismatch");
        }
        if (input.supportedRendererContractVersion !== undefined
          && snapshot.rendererContractVersion
            !== input.supportedRendererContractVersion) {
          throw runtimeError("publication_renderer_contract_incompatible");
        }
        if (!["initial", "delta", "repair"].includes(snapshot.planningMode)) {
          throw runtimeError("publication_planning_mode_invalid");
        }
        if (snapshot.planningMode === "delta"
          && snapshot.affectedSourceFilePublicIds.length === 0) {
          throw runtimeError("publication_delta_closure_incomplete");
        }
        const rendered = await observeStage({
          input,
          snapshot,
          scopeGenerationPublicId: request.claim.publicId,
          stage: "render",
          signal: controller.signal,
          operation: () => input.render(snapshot, controller.signal, async () => {
            await new Promise<void>((resolve) => setImmediate(resolve));
            controller.signal.throwIfAborted();
            await heartbeat();
            controller.signal.throwIfAborted();
          })
        });
        await heartbeat(true);
        controller.signal.throwIfAborted();
        await observeStage({
          input,
          snapshot,
          scopeGenerationPublicId: request.claim.publicId,
          stage: "database_persist",
          signal: controller.signal,
          operation: () => input.outputs.persistOutput({
            scopeGenerationPublicId: request.claim.publicId,
            workerId: request.workerId,
            leaseGeneration: request.claim.leaseGeneration,
            checkedAt: input.now?.() ?? request.checkedAt,
            ...rendered
          })
        });
        const putPages = rendered.pages.filter((page) => page.action === "put");
        const objectPutCount = rendered.storageRequests?.put
          ?? rendered.verifiedReservations.length;
        const touchedPaths = new Set(rendered.pages.map((page) =>
          page.normalizedPath));
        const structurallyReusedObjectCount = snapshot.basePages.filter((page) =>
          page.action === "put" && !touchedPaths.has(page.normalizedPath)
        ).length;
        const memory = resourceSnapshot();
        input.onPersisted?.({
          snapshot,
          recordsRendered: nonNegativeEvidenceMetric(
            rendered.validationEvidence.recordsRendered
          ),
          objectPutCount,
          objectReuseCount: structurallyReusedObjectCount
            + Math.max(0, putPages.length - objectPutCount),
          putByteCount: rendered.storageRequests?.attemptedBytes
            ?? putPages.reduce((total, page) =>
              total + (page.byteCount ?? 0), 0),
          renewalCount,
          maximumHeartbeatAgeMs,
          ...memory,
          changedRecordCount: nonNegativeEvidenceMetric(
            rendered.validationEvidence.changedRecordCount
          ),
          chunkCount: nonNegativeEvidenceMetric(
            rendered.validationEvidence.chunkCount
          ),
          peakBufferedRecordCount: nonNegativeEvidenceMetric(
            rendered.validationEvidence.peakBufferedRecordCount
          ),
          touchedShardCount: nonNegativeEvidenceMetric(
            rendered.validationEvidence.touchedShardCount
          )
        });
      } finally {
        if (timer) clearInterval(timer);
        clearTimeout(deadline);
        request.signal.removeEventListener("abort", abort);
      }
    }
  };
}

function nonNegativeEvidenceMetric(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

async function observeStage<T>(request: {
  input: Parameters<typeof createDocumentPublicationScopeGenerationExecutor>[0];
  snapshot: DocumentPublicationImmutableScopeSnapshot | null;
  scopeGenerationPublicId: string;
  stage: "snapshot_load" | "render" | "database_persist";
  signal: AbortSignal;
  operation(): Promise<T>;
}): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await raceWithSignal(request.operation(), request.signal);
    request.input.onStage?.({
      snapshot: request.snapshot,
      scopeGenerationPublicId: request.scopeGenerationPublicId,
      stage: request.stage,
      outcome: "completed",
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      errorCode: null,
      ...resourceSnapshot()
    });
    return result;
  } catch (error) {
    request.input.onStage?.({
      snapshot: request.snapshot,
      scopeGenerationPublicId: request.scopeGenerationPublicId,
      stage: request.stage,
      outcome: "failed",
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      errorCode: safeCode(error),
      ...resourceSnapshot()
    });
    throw error;
  }
}

async function raceWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

function safeCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? error.code : null;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,128}$/u.test(code)
    ? code : "DOCUMENT_PROCESSING_FAILED";
}

function boundedExecutionMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_800_000) {
    throw runtimeError("scope_generation_deadline_invalid");
  }
  return value;
}

function resourceSnapshot() {
  const memory = process.memoryUsage();
  return {
    heapUsedBytes: memory.heapUsed,
    heapLimitBytes: getHeapStatistics().heap_size_limit,
    rssBytes: memory.rss
  };
}

function runtimeError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Publication scope runtime error: ${code}`), {
    code
  });
}
