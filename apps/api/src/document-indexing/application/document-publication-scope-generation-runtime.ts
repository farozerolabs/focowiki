import type { DocumentLeaseGeneration } from
  "../domain/document-publication-identifiers.js";

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
  deterministicChangedAt: string;
  baseGenerationPublicId: string | null;
  members: readonly Readonly<{
    kind: string;
    publicId: string;
    version: string;
    order: number;
    sourceFilePublicId: string | null;
  }>[];
  basePages: readonly Readonly<{
    normalizedPath: string;
    action: "put" | "delete";
    entryKind: string | null;
    objectId: string | null;
    checksumSha256: string | null;
    byteCount: number | null;
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
  now?: () => string;
  render(
    snapshot: DocumentPublicationImmutableScopeSnapshot,
    signal: AbortSignal
  ): Promise<RenderedScopeOutput>;
  onPersisted?(input: Readonly<{
    snapshot: DocumentPublicationImmutableScopeSnapshot;
    objectPutCount: number;
    objectReuseCount: number;
    putByteCount: number;
  }>): void;
  onStage?(input: Readonly<{
    snapshot: DocumentPublicationImmutableScopeSnapshot | null;
    scopeGenerationPublicId: string;
    stage: "snapshot_load" | "render" | "database_persist";
    outcome: "completed" | "failed";
    durationMs: number;
    errorCode: string | null;
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
      const heartbeat = async () => {
        if (!input.leases) return;
        const renewed = await input.leases.heartbeat({
          publicId: request.claim.publicId,
          workerId: request.workerId,
          leaseGeneration: request.claim.leaseGeneration,
          now: input.now?.() ?? request.checkedAt,
          leaseDurationMs: input.leaseDurationMs ?? 30_000
        });
        if (!renewed) {
          const error = runtimeError("scope_generation_lease_lost");
          controller.abort(error);
          throw error;
        }
      };
      let timer: ReturnType<typeof setInterval> | null = null;
      try {
        controller.signal.throwIfAborted();
        await heartbeat();
        if (input.leases) {
          timer = setInterval(() => void heartbeat().catch((error) => {
            controller.abort(error);
          }), input.heartbeatIntervalMs ?? 10_000);
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
        const rendered = await observeStage({
          input,
          snapshot,
          scopeGenerationPublicId: request.claim.publicId,
          stage: "render",
          signal: controller.signal,
          operation: () => input.render(snapshot, controller.signal)
        });
        await heartbeat();
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
        const objectPutCount = rendered.verifiedReservations.length;
        input.onPersisted?.({
          snapshot,
          objectPutCount,
          objectReuseCount: Math.max(0, putPages.length - objectPutCount),
          putByteCount: putPages.reduce(
            (total, page) => total + (page.byteCount ?? 0),
            0
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
      errorCode: null
    });
    return result;
  } catch (error) {
    request.input.onStage?.({
      snapshot: request.snapshot,
      scopeGenerationPublicId: request.scopeGenerationPublicId,
      stage: request.stage,
      outcome: "failed",
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      errorCode: safeCode(error)
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

function runtimeError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Publication scope runtime error: ${code}`), {
    code
  });
}
