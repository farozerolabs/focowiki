import type { DocumentWorkKind } from "../domain/document-work-graph.js";
import type {
  ClaimedDocumentArtifactWork,
  DocumentArtifactWorkRepository,
  DocumentReceiptKind
} from "./document-work-port.js";
import { documentWorkResourceLane } from "./document-work-resource-map.js";
import { safeDocumentDiagnosticPath } from
  "./document-error-diagnostic-path.js";

type HandlerReceipt = {
  key: string;
  outputFingerprintSha256: string;
  value: Readonly<Record<string, unknown>>;
  serviceEndedAt: string;
  committedByHandler?: boolean;
  disposition?: "waiting_on_projection";
};

type DocumentWorkHandler = (input: {
  claimed: ClaimedDocumentArtifactWork;
  signal: AbortSignal;
  releasePrimaryLane(): void;
}) => Promise<HandlerReceipt>;

type RuntimeWorkRepository = Pick<DocumentArtifactWorkRepository,
"complete" | "heartbeat" | "fail" | "defer" | "recoverExpired">;

export type DocumentWorkRuntimeEvent = {
  event: "claimed" | "completed" | "waiting_on_projection"
    | "deferred" | "failed";
  work: ClaimedDocumentArtifactWork;
  errorCode: string | null;
  errorConstraint?: string | null;
  errorResource?: string | null;
  errorTarget?: string | null;
  error?: unknown;
  retryable?: boolean;
};

const RECEIPT_KIND_BY_WORK: Record<DocumentWorkKind, DocumentReceiptKind> = {
  prepare: "parsed_source",
  first_layer: "first_layer",
  content_projection: "embedding",
  graphrag: "graphrag",
  relation_reconcile: "relation_reconciliation",
  knowledge_projection: "generated_page",
  activate: "activation",
  cleanup: "cleanup"
};

const DOCUMENT_WORK_CLAIM_ORDER: readonly DocumentWorkKind[] = [
  "prepare",
  "first_layer",
  "content_projection",
  "graphrag",
  "relation_reconcile",
  "activate",
  "knowledge_projection",
  "cleanup"
];

export function createDocumentFixedDagRuntime(input: {
  workerId: string;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  scheduler: {
    claimAvailable?(request: {
      kind: DocumentWorkKind;
      resourceLane: ReturnType<typeof documentWorkResourceLane>;
      workerId: string;
      now: string;
      leaseDurationMs: number;
      signal?: AbortSignal;
    }): Promise<readonly ClaimedDocumentArtifactWork[]>;
    claimOne(request: {
      kind: DocumentWorkKind;
      resourceLane: ReturnType<typeof documentWorkResourceLane>;
      workerId: string;
      now: string;
      leaseDurationMs: number;
      signal?: AbortSignal;
    }): Promise<ClaimedDocumentArtifactWork | null>;
    release(
      publicId: string,
      outcome?: "success" | "failure" | "rate_limited" | "timeout"
    ): void;
  };
  work: RuntimeWorkRepository;
  handlers: Partial<Record<DocumentWorkKind, DocumentWorkHandler>>;
  now(): string;
  clockMs?(): number;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  classifyError(error: unknown): {
    code: string;
    safeMessage: string | null;
    retryable: boolean;
    automaticRetry?: boolean;
  };
  retryDelayMs?(attemptCount: number): number;
  idlePollIntervalMs?: number;
  recoveryIntervalMs?: number;
  recoveryLimit?: number;
  onError?(error: unknown, work: ClaimedDocumentArtifactWork): void;
  onWorkEvent?(event: DocumentWorkRuntimeEvent): void;
}) {
  validateRuntimeInput(input);
  const active = new Set<Promise<void>>();
  let claimOrderOffset = 0;
  const nextClaimAt = new Map<DocumentWorkKind, number>();
  const clockMs = input.clockMs ?? Date.now;

  async function runOne(
    kind: DocumentWorkKind,
    signal: AbortSignal
  ): Promise<boolean> {
    const launched = await claimAndLaunch(kind, signal);
    if (!launched) return false;
    await launched.completion;
    return true;
  }

  async function claimAndLaunch(
    kind: DocumentWorkKind,
    signal: AbortSignal
  ): Promise<{ completion: Promise<void> } | null> {
    const handler = input.handlers[kind];
    if (!handler || signal.aborted) return null;
    const claimed = await input.scheduler.claimOne({
      kind,
      resourceLane: documentWorkResourceLane(kind),
      workerId: input.workerId,
      now: input.now(),
      leaseDurationMs: input.leaseDurationMs,
      signal
    });
    if (!claimed) return null;
    return launchClaimed(claimed, handler, signal);
  }

  async function claimAndLaunchAvailable(
    kind: DocumentWorkKind,
    signal: AbortSignal
  ): Promise<number> {
    const handler = input.handlers[kind];
    if (!handler || signal.aborted) return 0;
    const claimed = input.scheduler.claimAvailable
      ? await input.scheduler.claimAvailable({
          kind,
          resourceLane: documentWorkResourceLane(kind),
          workerId: input.workerId,
          now: input.now(),
          leaseDurationMs: input.leaseDurationMs,
          signal
        })
      : await input.scheduler.claimOne({
          kind,
          resourceLane: documentWorkResourceLane(kind),
          workerId: input.workerId,
          now: input.now(),
          leaseDurationMs: input.leaseDurationMs,
          signal
        }).then((work) => work ? [work] : []);
    claimed.forEach((work) => launchClaimed(work, handler, signal));
    return claimed.length;
  }

  function launchClaimed(
    claimed: ClaimedDocumentArtifactWork,
    handler: DocumentWorkHandler,
    signal: AbortSignal
  ): { completion: Promise<void> } {
    input.onWorkEvent?.({ event: "claimed", work: claimed, errorCode: null });
    let laneReleased = false;
    const releasePrimaryLane = (
      outcome: "success" | "failure" | "rate_limited" | "timeout" = "success"
    ) => {
      if (laneReleased) return;
      laneReleased = true;
      input.scheduler.release(claimed.publicId, outcome);
    };
    const execution = executeClaimed(claimed, handler, signal, releasePrimaryLane)
      .catch((error: unknown) => input.onError?.(error, claimed))
      .finally(releasePrimaryLane);
    active.add(execution);
    void execution.finally(() => active.delete(execution));
    return { completion: execution };
  }

  async function executeClaimed(
    claimed: ClaimedDocumentArtifactWork,
    handler: DocumentWorkHandler,
    parentSignal: AbortSignal,
    releasePrimaryLane: (
      outcome?: "success" | "failure" | "rate_limited" | "timeout"
    ) => void
  ): Promise<void> {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(parentSignal.reason);
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener("abort", abortFromParent, { once: true });
    let heartbeatRunning = false;
    const heartbeat = setInterval(() => {
      if (heartbeatRunning || controller.signal.aborted) return;
      heartbeatRunning = true;
      void input.work.heartbeat({
        publicId: claimed.publicId,
        workerId: input.workerId,
        now: input.now(),
        leaseDurationMs: input.leaseDurationMs
      }).then((owned) => {
        if (!owned && !controller.signal.aborted) {
          controller.abort(workRuntimeError("DOCUMENT_WORK_LEASE_LOST"));
        }
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) controller.abort(error);
      }).finally(() => { heartbeatRunning = false; });
    }, input.heartbeatIntervalMs);
    heartbeat.unref?.();
    try {
      const receipt = await handler({
        claimed,
        signal: controller.signal,
        releasePrimaryLane
      });
      validateHandlerReceipt(receipt);
      if (controller.signal.aborted) {
        throw controller.signal.reason
          ?? workRuntimeError("DOCUMENT_WORK_ABORTED");
      }
      const completed = receipt.committedByHandler === true || await input.work.complete({
        publicId: claimed.publicId,
        workerId: input.workerId,
        now: input.now(),
        receipt: {
          kind: RECEIPT_KIND_BY_WORK[claimed.kind],
          key: receipt.key,
          inputFingerprintSha256: claimed.inputFingerprintSha256,
          outputFingerprintSha256: receipt.outputFingerprintSha256,
          value: receipt.value
        }
      });
      if (!completed) throw workRuntimeError("DOCUMENT_WORK_LEASE_LOST");
      input.onWorkEvent?.({
        event: receipt.disposition ?? "completed",
        work: claimed,
        errorCode: null
      });
    } catch (error) {
      if (parentSignal.aborted) {
        releasePrimaryLane("failure");
        throw error;
      }
      const diagnostic = input.classifyError(error);
      if (isNonAttemptingDeferral(diagnostic.code)) {
        if (!input.work.defer) {
          throw workRuntimeError("DOCUMENT_WORK_DEFER_UNAVAILABLE");
        }
        releasePrimaryLane();
        const deferred = await input.work.defer({
          publicId: claimed.publicId,
          workerId: input.workerId,
          now: input.now(),
          nextEligibleAt: new Date(Date.parse(input.now()) + 250).toISOString()
        });
        if (!deferred) throw workRuntimeError("DOCUMENT_WORK_LEASE_LOST");
        input.onWorkEvent?.({
          event: "deferred",
          work: claimed,
          errorCode: diagnostic.code
        });
        return;
      }
      releasePrimaryLane(adaptiveOutcome(diagnostic.code));
      const automaticRetry = (diagnostic.automaticRetry ?? diagnostic.retryable)
        && claimed.attemptCount < claimed.maximumAttempts;
      const delay = automaticRetry
        ? (input.retryDelayMs?.(claimed.attemptCount) ?? 1_000)
        : null;
      await input.work.fail({
        publicId: claimed.publicId,
        workerId: input.workerId,
        now: input.now(),
        errorCode: diagnostic.code,
        safeMessage: diagnostic.safeMessage,
        retryable: diagnostic.retryable,
        nextEligibleAt: delay === null
          ? null
          : new Date(Date.parse(input.now()) + delay).toISOString()
      });
      input.onWorkEvent?.({
        event: "failed",
        work: claimed,
        errorCode: diagnostic.code,
        error,
        retryable: diagnostic.retryable,
        errorConstraint: safeErrorConstraint(error),
        errorResource: safeErrorPath(error, "resourcePath"),
        errorTarget: safeErrorPath(error, "targetPath")
      });
    } finally {
      clearInterval(heartbeat);
      parentSignal.removeEventListener("abort", abortFromParent);
    }
  }

  return {
    runOne,
    async run(signal: AbortSignal): Promise<void> {
      const idlePollIntervalMs = input.idlePollIntervalMs ?? 250;
      const recoveryIntervalMs = input.recoveryIntervalMs ?? 5_000;
      const recoveryLimit = input.recoveryLimit ?? 100;
      let nextRecoveryAt = 0;
      while (!signal.aborted) {
        const now = Date.now();
        if (now >= nextRecoveryAt) {
          const current = input.now();
          await input.work.recoverExpired({
            now: current,
            retryAt: new Date(
              Date.parse(current) + (input.retryDelayMs?.(1) ?? 1_000)
            ).toISOString(),
            limit: recoveryLimit
          });
          nextRecoveryAt = now + recoveryIntervalMs;
        }
        let launched = false;
        for (let index = 0; index < DOCUMENT_WORK_CLAIM_ORDER.length; index += 1) {
          const kind = DOCUMENT_WORK_CLAIM_ORDER[
            (claimOrderOffset + index) % DOCUMENT_WORK_CLAIM_ORDER.length
          ]!;
          if ((nextClaimAt.get(kind) ?? 0) > clockMs()) continue;
          const claimedCount = await claimAndLaunchAvailable(kind, signal);
          if (claimedCount === 0) {
            nextClaimAt.set(kind, clockMs() + idlePollIntervalMs);
          } else {
            nextClaimAt.delete(kind);
          }
          launched ||= claimedCount > 0;
        }
        claimOrderOffset = (claimOrderOffset + 1) % DOCUMENT_WORK_CLAIM_ORDER.length;
        if (!launched && !signal.aborted) {
          await input.wait(idlePollIntervalMs, signal);
          nextClaimAt.clear();
        }
      }
      await Promise.allSettled([...active]);
    },
    activeCount(): number {
      return active.size;
    }
  };
}

function safeErrorPath(
  error: unknown,
  property: "resourcePath" | "targetPath"
): string | null {
  if (typeof error !== "object" || error === null || !(property in error)) {
    return null;
  }
  const value = (error as Record<string, unknown>)[property];
  return safeDocumentDiagnosticPath(typeof value === "string" ? value : null);
}

function isNonAttemptingDeferral(code: string): boolean {
  return code === "GENERATION_WAITER_LIMIT_EXCEEDED"
    || code === "document_activation_rebase_required";
}

function safeErrorConstraint(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const constraint = "constraint_name" in error
    ? error.constraint_name
    : "constraint" in error ? error.constraint : null;
  return typeof constraint === "string"
    && /^[a-zA-Z0-9_]{1,128}$/u.test(constraint)
    ? constraint
    : null;
}

function adaptiveOutcome(
  code: string
): "failure" | "rate_limited" | "timeout" {
  if (/(?:RATE_LIMIT|THROTTL|TOO_MANY_REQUESTS|HTTP_?429)/iu.test(code)) {
    return "rate_limited";
  }
  if (/(?:TIMEOUT|TIMED_OUT|DEADLINE)/iu.test(code)) return "timeout";
  return "failure";
}

function validateRuntimeInput(input: {
  workerId: string;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
}): void {
  if (!input.workerId || Buffer.byteLength(input.workerId, "utf8") > 255
    || !Number.isSafeInteger(input.leaseDurationMs)
    || input.leaseDurationMs < 1_000 || input.leaseDurationMs > 300_000
    || !Number.isSafeInteger(input.heartbeatIntervalMs)
    || input.heartbeatIntervalMs < 100
    || input.heartbeatIntervalMs >= input.leaseDurationMs) {
    throw workRuntimeError("DOCUMENT_WORK_RUNTIME_CONFIGURATION_INVALID");
  }
}

function validateHandlerReceipt(receipt: HandlerReceipt): void {
  if (Buffer.byteLength(receipt.key, "utf8") > 1_024
    || !/^[0-9a-f]{64}$/u.test(receipt.outputFingerprintSha256)
    || !Number.isFinite(Date.parse(receipt.serviceEndedAt))
    || Buffer.byteLength(JSON.stringify(receipt.value), "utf8") > 131_072
    || (receipt.committedByHandler !== undefined
      && receipt.committedByHandler !== true)
    || (receipt.disposition !== undefined
      && (receipt.disposition !== "waiting_on_projection"
        || receipt.committedByHandler !== true))) {
    throw workRuntimeError("DOCUMENT_WORK_RECEIPT_INVALID");
  }
}

function workRuntimeError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document work runtime error: ${code}`), { code });
}
