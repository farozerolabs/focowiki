import { createHash } from "node:crypto";
import type {
  DocumentPublicationBasePage,
  DocumentPublicationJobOutput,
  DocumentPublicationRenderScope
} from "./document-publication-job-ports.js";
import { planDocumentPublicationJob, type DocumentPublicationItemDelta }
  from "./document-publication-job-plan.js";
import { buildDocumentPublicationAffectedClosure } from
  "./document-publication-affected-closure.js";
import {
  canonicalDocumentPublicationValue,
  fingerprintDocumentPublicationOutputs
} from "./document-publication-manifest.js";

export type DocumentPublicationRenderedScope = Readonly<{
  outputFingerprintSha256: string;
  pages: readonly Readonly<{
    logicalPath: string;
    normalizedPath: string;
    entryKind: string;
    sourceFilePublicId?: string | null;
    sourceRevisionPublicId?: string | null;
    objectId: string;
    checksumSha256: string;
    byteCount: number;
  }>[];
  removedNormalizedPaths: readonly string[];
  navigationMutations: readonly Readonly<Record<string, unknown>>[];
  objectReuseCount?: number;
  storageRequests?: Readonly<{
    put: number;
    head: number;
    verification: number;
    attemptedBytes: number;
  }>;
}>;

export async function buildDocumentPublicationJob(input: Readonly<{
  jobPublicId: string;
  knowledgeBaseId: string;
  baseActiveRevision: number;
  baseDeterministicChangedAt?: string | null;
  targetReadinessSequence: number;
  rendererContractVersion: string;
  deterministicChangedAt: string;
  documents: readonly DocumentPublicationItemDelta[];
  signal: AbortSignal;
  checkpoint(): Promise<void>;
  render(
    scope: DocumentPublicationRenderScope,
    options: Readonly<{
      contributors: readonly Readonly<{
        sourceFilePublicId: string;
        sourceRevisionPublicId: string | null;
        requiredSequence: number;
      }>[];
      affectedSourceFilePublicIds: readonly string[];
      affectedLogicalPaths: readonly string[];
      affectedTermBuckets: readonly string[];
      planningMode: "initial" | "delta" | "repair";
      basePages: readonly DocumentPublicationBasePage[];
    }>,
    signal: AbortSignal
  ): Promise<DocumentPublicationRenderedScope>;
  readObjectMetadata(objectIds: readonly string[]): Promise<readonly Readonly<{
    objectId: string;
    contentType: string;
  }>[]>;
  readBasePages(scope: DocumentPublicationRenderScope):
    Promise<readonly DocumentPublicationBasePage[]>;
  maximumConcurrency?: number;
}>): Promise<Readonly<{
  fingerprintSha256: string;
  outputs: readonly DocumentPublicationJobOutput[];
  objectPutCount: number;
  objectReuseCount: number;
  objectRequestCount: number;
  objectAttemptedBytes: number;
}>> {
  const planningMode = input.baseActiveRevision === 0 ? "initial" : "delta";
  const closure = buildDocumentPublicationAffectedClosure({
    planningMode,
    documents: input.documents
  });
  const plan = planDocumentPublicationJob({
    jobPublicId: input.jobPublicId,
    targetReadinessSequence: input.targetReadinessSequence,
    rendererContractVersion: input.rendererContractVersion,
    deterministicChangedAt: input.deterministicChangedAt,
    documents: input.documents
  });
  const contributors = input.documents.map((document) => ({
    sourceFilePublicId: document.sourceFilePublicId,
    sourceRevisionPublicId: document.operation === "delete"
      ? null : document.sourceRevisionPublicId,
    requiredSequence: document.readinessSequence
  }));
  const affectedSourceFilePublicIds = [...new Set(closure.members.flatMap(
    (member) => member.sourceFilePublicId ? [member.sourceFilePublicId] : []
  ))];
  const affectedLogicalPaths = closure.members.flatMap((member) =>
    ["prior_path", "successor_path"].includes(member.kind)
      ? [member.publicId] : []);
  const affectedTermBuckets = [...new Set(input.documents.flatMap((document) =>
    [...document.priorTermBuckets, ...document.nextTermBuckets]))].sort(bytewise);
  const deletedSources = new Set(input.documents.flatMap((document) =>
    document.operation === "delete" ? [document.sourceFilePublicId] : []));
  const renderableNodes = plan.work.filter((node) =>
    node.kind !== "validation"
    && !(node.kind === "source" && deletedSources.has(node.key)));
  const renderableIdentities = new Set(renderableNodes.map((node) =>
    node.identity));
  const renderableByIdentity = new Map(renderableNodes.map((node) =>
    [node.identity, node] as const));
  const limiter = createPromiseLimiter(validateMaximumConcurrency(
    input.maximumConcurrency ?? 8
  ));
  const rendering = new Map<string, Promise<DocumentPublicationRenderedScope>>();
  const renderNode = (node: (typeof renderableNodes)[number]) => {
    const existing = rendering.get(node.identity);
    if (existing) return existing;
    const execution = (async () => {
      await Promise.all(node.dependsOn.filter((dependency) =>
        renderableIdentities.has(dependency)).map((dependency) => {
          const prerequisite = renderableByIdentity.get(dependency);
          if (!prerequisite) throw builderError("publication_dependency_missing");
          return renderNode(prerequisite);
        }));
      await input.checkpoint();
      const scope: DocumentPublicationRenderScope = {
        publicId: `${input.jobPublicId}:${node.identity}`,
        knowledgeBaseId: input.knowledgeBaseId,
        kind: node.kind as DocumentPublicationRenderScope["kind"],
        key: node.key,
        requiredSequence: input.targetReadinessSequence,
        renderedSequence: 0,
        deterministicEventTime: input.deterministicChangedAt
      };
      return limiter(async () => {
        const basePages = input.baseActiveRevision === 0
          ? [] : await input.readBasePages(scope);
        return input.render(scope, {
          contributors,
          affectedSourceFilePublicIds,
          affectedLogicalPaths,
          affectedTermBuckets,
          planningMode,
          ...(input.baseDeterministicChangedAt
            ? { baseDeterministicChangedAt:
                input.baseDeterministicChangedAt } : {}),
          basePages
        }, input.signal);
      });
    })();
    rendering.set(node.identity, execution);
    return execution;
  };
  const rendered = await Promise.all(renderableNodes.map(renderNode));
  await input.checkpoint();
  const putPages = rendered.flatMap((scope) => scope.pages.map((page, index) => ({
    ...page,
    producerFingerprintSha256: scope.outputFingerprintSha256,
    navigationMutations: index === 0 ? scope.navigationMutations : []
  })));
  const detachedNavigationMutations = new Map<string,
    Readonly<Record<string, unknown>>[]>();
  for (const scope of rendered) {
    if (scope.pages.length > 0 || scope.navigationMutations.length === 0) {
      continue;
    }
    const targetPath = [...scope.removedNormalizedPaths]
      .sort(bytewise)[0]?.toLocaleLowerCase("en-US");
    if (!targetPath) {
      throw builderError("publication_navigation_output_missing");
    }
    detachedNavigationMutations.set(targetPath, [
      ...(detachedNavigationMutations.get(targetPath) ?? []),
      ...scope.navigationMutations
    ]);
  }
  const objectMetadata = new Map((await input.readObjectMetadata(
    [...new Set(putPages.map((page) => page.objectId))]
  )).map((object) => [object.objectId, object]));
  const byPath = new Map<string, DocumentPublicationJobOutput>();
  for (const page of putPages) {
    const metadata = objectMetadata.get(page.objectId);
    if (!metadata) throw builderError("publication_object_metadata_missing");
    addOutput(byPath, {
      normalizedPath: page.normalizedPath,
      logicalPath: page.logicalPath,
      action: "put",
      entryKind: page.entryKind,
      sourceFilePublicId: page.sourceFilePublicId ?? null,
      sourceRevisionPublicId: page.sourceRevisionPublicId ?? null,
      objectId: page.objectId,
      checksumSha256: page.checksumSha256,
      byteCount: page.byteCount,
      contentType: metadata.contentType,
      producerFingerprintSha256: page.producerFingerprintSha256,
      navigationMutations: page.navigationMutations
    });
  }
  const removedPaths = new Set([
    ...plan.deletePaths.map((path) => path.toLocaleLowerCase("en-US")),
    ...rendered.flatMap((scope) => scope.removedNormalizedPaths)
  ]);
  for (const normalizedPath of removedPaths) {
    if (byPath.has(normalizedPath)) continue;
    addOutput(byPath, {
      normalizedPath,
      logicalPath: normalizedPath,
      action: "delete",
      entryKind: null,
      sourceFilePublicId: null,
      sourceRevisionPublicId: null,
      objectId: null,
      checksumSha256: null,
      byteCount: null,
      contentType: null,
      producerFingerprintSha256: createHash("sha256")
        .update(`${input.jobPublicId}\0delete\0${normalizedPath}`).digest("hex"),
      navigationMutations: []
    });
  }
  for (const [normalizedPath, navigationMutations]
    of [...detachedNavigationMutations].sort(([left], [right]) =>
      bytewise(left, right))) {
    const output = byPath.get(normalizedPath);
    if (!output) {
      throw builderError("publication_navigation_output_missing");
    }
    byPath.set(normalizedPath, {
      ...output,
      navigationMutations: [
        ...output.navigationMutations,
        ...navigationMutations
      ]
    });
  }
  const outputs = [...byPath.values()].sort((left, right) =>
    bytewise(left.normalizedPath, right.normalizedPath));
  if (outputs.length === 0) {
    throw builderError("publication_output_manifest_empty");
  }
  return {
    fingerprintSha256: fingerprintDocumentPublicationOutputs(outputs),
    outputs,
    objectPutCount: rendered.reduce((total, scope) =>
      total + (scope.storageRequests?.put ?? 0), 0),
    objectReuseCount: rendered.reduce((total, scope) =>
      total + (scope.objectReuseCount ?? 0), 0),
    objectRequestCount: rendered.reduce((total, scope) =>
      total + (scope.storageRequests
        ? scope.storageRequests.put + scope.storageRequests.head
          + scope.storageRequests.verification
        : 0), 0),
    objectAttemptedBytes: rendered.reduce((total, scope) =>
      total + (scope.storageRequests?.attemptedBytes ?? 0), 0)
  };
}

function validateMaximumConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw builderError("publication_builder_concurrency_invalid");
  }
  return value;
}

function addOutput(
  outputs: Map<string, DocumentPublicationJobOutput>,
  output: DocumentPublicationJobOutput
): void {
  const existing = outputs.get(output.normalizedPath);
  if (existing && canonicalDocumentPublicationValue(existing)
    !== canonicalDocumentPublicationValue(output)) {
    throw builderError("publication_output_path_conflict");
  }
  outputs.set(output.normalizedPath, output);
}

function bytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function builderError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Publication job builder error: ${code}`), {
    code
  });
}

function createPromiseLimiter(maximumConcurrency: number) {
  let activeCount = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (activeCount >= maximumConcurrency) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    activeCount += 1;
    try {
      return await task();
    } finally {
      activeCount -= 1;
      waiting.shift()?.();
    }
  };
}
