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
import { runDocumentPublicationScopesBounded } from
  "./document-publication-scope-scheduler.js";

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
  peakActiveScopeCount: number;
  outputCount: number;
  navigationMutationCount: number;
  navigationLeafCount: number;
  navigationEntryCount: number;
  maximumNavigationMutationBytes: number;
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
  const putPages: Array<DocumentPublicationRenderedScope["pages"][number]
    & { producerFingerprintSha256: string;
      navigationMutations: readonly Readonly<Record<string, unknown>>[] }> = [];
  const removedPaths = new Set(plan.deletePaths.map((path) =>
    path.toLocaleLowerCase("en-US")));
  const detachedNavigationMutations = new Map<string,
    Readonly<Record<string, unknown>>[]>();
  let objectPutCount = 0;
  let objectReuseCount = 0;
  let objectRequestCount = 0;
  let objectAttemptedBytes = 0;
  const scheduling = await runDocumentPublicationScopesBounded({
    nodes: renderableNodes,
    maximumConcurrency: validateMaximumConcurrency(
      input.maximumConcurrency ?? 8
    ),
    signal: input.signal,
    async execute(node, renderSignal) {
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
      }, renderSignal);
    },
    consume(_node, rendered) {
      putPages.push(...rendered.pages.map((page, index) => ({
        ...page,
        producerFingerprintSha256: rendered.outputFingerprintSha256,
        navigationMutations: index === 0 ? rendered.navigationMutations : []
      })));
      rendered.removedNormalizedPaths.forEach((path) =>
        removedPaths.add(path));
      if (rendered.pages.length === 0
        && rendered.navigationMutations.length > 0) {
        const targetPath = [...rendered.removedNormalizedPaths]
          .sort(bytewise)[0]?.toLocaleLowerCase("en-US");
        if (!targetPath) {
          throw builderError("publication_navigation_output_missing");
        }
        detachedNavigationMutations.set(targetPath, [
          ...(detachedNavigationMutations.get(targetPath) ?? []),
          ...rendered.navigationMutations
        ]);
      }
      objectPutCount += rendered.storageRequests?.put ?? 0;
      objectReuseCount += rendered.objectReuseCount ?? 0;
      objectRequestCount += rendered.storageRequests
        ? rendered.storageRequests.put + rendered.storageRequests.head
          + rendered.storageRequests.verification
        : 0;
      objectAttemptedBytes += rendered.storageRequests?.attemptedBytes ?? 0;
    }
  });
  await input.checkpoint();
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
        ...navigationMutations.sort((left, right) => bytewise(
          canonicalDocumentPublicationValue(left),
          canonicalDocumentPublicationValue(right)
        ))
      ]
    });
  }
  const outputs = [...byPath.values()].sort((left, right) =>
    bytewise(left.normalizedPath, right.normalizedPath));
  if (outputs.length === 0) {
    throw builderError("publication_output_manifest_empty");
  }
  const navigationMutations = outputs.flatMap((output) =>
    output.navigationMutations);
  return {
    fingerprintSha256: fingerprintDocumentPublicationOutputs(outputs),
    outputs,
    objectPutCount,
    objectReuseCount,
    objectRequestCount,
    objectAttemptedBytes,
    peakActiveScopeCount: scheduling.peakActiveCount,
    outputCount: outputs.length,
    navigationMutationCount: navigationMutations.length,
    navigationLeafCount: navigationMutations.reduce((count, mutation) =>
      count + (Array.isArray(mutation.touchedLeaves)
        ? mutation.touchedLeaves.length : 0), 0),
    navigationEntryCount: navigationMutations.reduce((count, mutation) =>
      count + (Array.isArray(mutation.touchedLeaves)
        ? mutation.touchedLeaves.reduce((leafCount, leaf) =>
            leafCount + (Array.isArray(leaf.entries) ? leaf.entries.length : 0), 0)
        : 0), 0),
    maximumNavigationMutationBytes: navigationMutations.reduce(
      (maximum, mutation) => Math.max(maximum,
        Buffer.byteLength(JSON.stringify(mutation), "utf8")), 0)
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
