import { createHash } from "node:crypto";
import {
  analyzeOkfMetadata,
  inspectOkfMarkdownFile,
  parseUploadedMarkdownSource,
  type OkfDiagnostic
} from "@focowiki/okf";
import type { PersistentDirectoryLeaf } from
  "../../application/ports/directory-navigation-repository.js";
import {
  STORAGE_VNEXT_CURRENT_NAVIGATION_PROFILE,
  STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES
} from "./profile.js";
import {
  parseStorageVnextExtensionNavigationState,
  STORAGE_VNEXT_EXTENSION_NAVIGATION_SHARD_KIND
} from "./extension-navigation-state.js";
import { isAllowedPublicGeneratedFilePath } from "../../public-generated-path.js";
import type {
  StorageVnextReleaseReadPort,
  StorageVnextReleaseWritePort
} from "../release/ports.js";
import type {
  StorageVnextSearchProjectionState
} from "../search/projection-repository.js";
import {
  STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS,
  resolveStorageVnextMarkdownTargets
} from "./validation.js";
import {
  compareStorageVnextEffectiveCatalogPaths,
  type StorageVnextEffectiveCatalogPort
} from "./effective-catalog.js";

type ReleasePort = Pick<
  StorageVnextReleaseReadPort & StorageVnextReleaseWritePort,
  | "getLiveCandidate"
  | "listCandidateDependencies"
  | "listCandidateShards"
  | "getKnowledgeBaseSummary"
  | "countCandidateOwnedObjects"
  | "markCandidateValidating"
  | "recordCandidateValidation"
  | "markCandidateReady"
>;

type ObjectValidationPort = {
  verify(input: {
    objectId: string;
    checksum: string;
    byteCount: number;
  }): Promise<boolean>;
  readText(input: {
    objectId: string;
    checksum: string;
    byteCount: number;
    maximumBytes: number;
  }): Promise<string>;
};

export function createStorageVnextPublicationCandidateValidator(input: {
  releases: ReleasePort;
  effectiveCatalog: StorageVnextEffectiveCatalogPort;
  objects: ObjectValidationPort;
  search: {
    getProjection(input: {
      knowledgeBaseId: string;
      publicId: string;
    }): Promise<{
      knowledgeBaseId: string;
      state: StorageVnextSearchProjectionState;
      documentCount: number;
    } | null>;
  };
  clock: () => string;
  limits: {
    maximumPageSize: number;
    maximumMarkdownBytes: number;
    objectReadConcurrency: number;
  };
}) {
  validateLimits(input.limits);
  return {
    async validate(request: {
      knowledgeBaseId: string;
      candidatePublicId: string;
      searchProjectionPublicId: string;
      expectedCandidateFactRevision?: number;
    }) {
      const candidate = await requireCandidate(input.releases, request);
      if (candidate.state === "building") {
        const expectedFactRevision = request.expectedCandidateFactRevision
          ?? candidate.factRevision;
        if (candidate.factRevision !== expectedFactRevision) {
          throw candidateValidationError("candidate_changed");
        }
        const changed = await input.releases.markCandidateValidating({
          candidatePublicId: candidate.publicId,
          expectedFactRevision
        });
        if (!changed) throw candidateValidationError("candidate_changed");
      } else if (candidate.state !== "validating") {
        throw new Error("Storage vNext publication candidate is not validatable");
      }

      const catalog = await validateCatalog(input, request, candidate.candidateRootPublicId);
      const extensionState = await validateShards(input, request.candidatePublicId);
      validateStorageVnextExtensionNavigationClosure({
        documents: catalog.extensionDocuments,
        resources: catalog.extensionResources,
        state: extensionState
      });
      const linkCount = await countLinkDependencies(input, request.candidatePublicId);
      const summary = await input.releases.getKnowledgeBaseSummary({
        knowledgeBaseId: request.knowledgeBaseId,
        releaseRootPublicId: candidate.candidateRootPublicId
      });
      if (!summary || summary.generatedEntryCount !== catalog.entryCount) {
        throw new Error("Storage vNext publication summary count is inconsistent");
      }
      const search = await requireSearch(input.search, request);
      const manifestChecksum = catalog.manifest.digest("hex");
      const objectOwnerCount = await input.releases.countCandidateOwnedObjects(
        request.candidatePublicId
      );
      if (!Number.isSafeInteger(objectOwnerCount) || objectOwnerCount < 0) {
        throw new Error("Storage vNext publication object owner count is invalid");
      }
      const receipt = {
        candidatePublicId: request.candidatePublicId,
        manifestChecksum,
        searchProjectionPublicId: request.searchProjectionPublicId,
        objectOwnerCount,
        searchDocumentCount: search.documentCount,
        graphNodeCount: summary.graphNodeCount,
        graphEdgeCount: summary.graphEdgeCount,
        linkCount,
        generatedEntryCount: summary.generatedEntryCount,
        navigationProfileVersion: STORAGE_VNEXT_CURRENT_NAVIGATION_PROFILE,
        objectValidationPassed: true,
        searchValidationPassed: true,
        graphValidationPassed: true,
        linkValidationPassed: true,
        countValidationPassed: true,
        pathValidationPassed: true,
        validatedAt: input.clock()
      } as const;
      if (!await input.releases.recordCandidateValidation(receipt)) {
        throw new Error("Storage vNext publication validation receipt was rejected");
      }
      if (!await input.releases.markCandidateReady({
        candidatePublicId: request.candidatePublicId,
        manifestChecksum
      })) throw new Error("Storage vNext publication candidate could not become ready");
      return receipt;
    }
  };
}

function candidateValidationError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext publication candidate validation error: ${code}`),
    { code }
  );
}

async function validateCatalog(
  input: Parameters<typeof createStorageVnextPublicationCandidateValidator>[0],
  request: { knowledgeBaseId: string; candidatePublicId: string },
  candidateRootPublicId: string
) {
  const manifest = createHash("sha256");
  const required: string[] = [];
  let cursor: string | null = null;
  let previousLogicalPath: string | null = null;
  let entryCount = 0;
  const extensionResources = new Set<string>();
  const extensionResourceLinks = new Map<string, number>();
  const sourcePathByPublicId = new Map<string, string>();
  const byFileEvidencePairs: Array<{ resourcePath: string; evidencePath: string }> = [];
  const extensionDocuments = new Map<string, readonly string[]>();
  let projectionCatalogBody: string | null = null;
  do {
    const page = await input.effectiveCatalog.listEffectiveCatalogEntries({
      ...request,
      limit: input.limits.maximumPageSize,
      cursor
    });
    if (page.items.length > input.limits.maximumPageSize) {
      throw new Error("Storage vNext publication catalog page exceeds its budget");
    }
    const linkTargets: string[] = [];
    for (const entry of page.items) {
      if (
        (previousLogicalPath !== null
          && compareStorageVnextEffectiveCatalogPaths(
            previousLogicalPath,
            entry.logicalPath
          ) >= 0)
        || !isAllowedPublicGeneratedFilePath(entry.logicalPath)
      ) throw new Error("Storage vNext publication catalog entry is invalid");
      previousLogicalPath = entry.logicalPath;
      if (entry.kind === "source" && !entry.logicalPath.startsWith("pages/")) {
        throw new Error("Storage vNext publication source mapping is invalid");
      }
      if (
        /\/index-map-\d{6}\.md$/u.test(entry.logicalPath)
        && entry.kind !== "source"
      ) throw new Error("Storage vNext publication contains obsolete navigation");
      if (entry.kind === "source" && entry.sourceFilePublicId) {
        sourcePathByPublicId.set(entry.sourceFilePublicId, entry.logicalPath);
      }
      if (isExtensionResourcePath(entry.logicalPath)) {
        extensionResources.add(entry.logicalPath);
      }
    }
    const readableBodies = await mapWithConcurrency(
      page.items,
      input.limits.objectReadConcurrency,
      async (entry) => (
        (entry.logicalPath.endsWith(".md") && entry.kind !== "source")
        || entry.logicalPath === "_index/catalog.json"
      )
        ? await input.objects.readText({
            objectId: entry.objectId,
            checksum: entry.checksum,
            byteCount: entry.byteCount,
            maximumBytes: input.limits.maximumMarkdownBytes
          })
        : await verifyUnreadEntry(input.objects, entry)
    );
    for (const [index, entry] of page.items.entries()) {
      const readableBody = readableBodies[index] ?? null;
      if (required.length < STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS.length) {
        required.push(entry.logicalPath);
      }
      manifest.update(`${JSON.stringify({
        path: entry.logicalPath,
        kind: entry.kind,
        source: entry.sourceFilePublicId,
        checksum: entry.checksum,
        bytes: entry.byteCount,
        ordinal: entry.ordinal
      })}\n`);
      if (entry.logicalPath === "_index/catalog.json") {
        if (readableBody === null || projectionCatalogBody !== null) {
          throw new Error("Storage vNext projection catalog is invalid");
        }
        projectionCatalogBody = readableBody;
      } else if (readableBody !== null) {
        validateStorageVnextOkfMarkdownMetadata({
          logicalPath: entry.logicalPath,
          kind: entry.kind,
          body: readableBody
        });
        if (entry.kind !== "source") {
          const targets = resolveStorageVnextMarkdownTargets(
            entry.logicalPath,
            readableBody
          );
          linkTargets.push(...targets);
          validateNavigationGlobals(entry.logicalPath, targets);
          if (isExtensionNavigationMarkdown(entry.logicalPath)) {
            extensionDocuments.set(entry.logicalPath, targets);
          }
          for (const target of targets) {
            if (isExtensionResourcePath(target)) {
              extensionResourceLinks.set(
                target,
                (extensionResourceLinks.get(target) ?? 0) + 1
              );
            }
          }
          if (entry.logicalPath.startsWith("_graph/by-file/index-")) {
            byFileEvidencePairs.push(...parseByFileEvidencePairs(readableBody));
          }
        }
      }
      entryCount += 1;
    }
    await assertLinkTargets(input, request, linkTargets);
    cursor = advancingCursor(cursor, page.nextCursor, "catalog");
  } while (cursor !== null);
  if (JSON.stringify(required) !== JSON.stringify(STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS)) {
    throw new Error("Storage vNext publication required navigation order changed");
  }
  if (projectionCatalogBody === null) {
    throw new Error("Storage vNext projection catalog is missing");
  }
  validateStorageVnextProjectionCatalogParity({
    body: projectionCatalogBody,
    knowledgeBaseId: request.knowledgeBaseId,
    generationId: request.candidatePublicId,
    extensionResources
  });
  for (const resourcePath of extensionResources) {
    if (extensionResourceLinks.get(resourcePath) !== 1) {
      throw new Error(`Storage vNext extension resource navigation is inconsistent: ${resourcePath}`);
    }
  }
  for (const linkedPath of extensionResourceLinks.keys()) {
    if (!extensionResources.has(linkedPath)) {
      throw new Error(`Storage vNext extension navigation advertises an absent resource: ${linkedPath}`);
    }
  }
  for (const pair of byFileEvidencePairs) {
    const sourcePublicId = decodeByFileSourcePublicId(pair.resourcePath);
    if (sourcePathByPublicId.get(sourcePublicId) !== pair.evidencePath) {
      throw new Error(`Storage vNext by-file evidence navigation is inconsistent: ${pair.resourcePath}`);
    }
  }
  const byFileResourceCount = [...extensionResources].filter((path) =>
    path.startsWith("_graph/by-file/")).length;
  if (byFileEvidencePairs.length !== byFileResourceCount) {
    throw new Error("Storage vNext by-file evidence coverage is inconsistent");
  }
  manifest.update(`root:${candidateRootPublicId}\nentries:${entryCount}\n`);
  return { manifest, entryCount, extensionDocuments, extensionResources };
}

export function validateStorageVnextOkfMarkdownMetadata(input: {
  logicalPath: string;
  kind: string;
  body: string;
}): readonly OkfDiagnostic[] {
  const profiles = input.kind === "source"
    ? ["normative", "recommended"] as const
    : ["normative", "recommended", "focowiki_quality", "focowiki_extension"] as const;
  const conformanceIssues = profiles.flatMap((profile) => inspectOkfMarkdownFile(
    { path: input.logicalPath, content: input.body },
    profile
  ));
  const blockingConformance = conformanceIssues.find((issue) =>
    issue.disposition === "blocking");
  if (blockingConformance) {
    throw new Error(
      `Storage vNext publication OKF 0.2 metadata is invalid: ${input.logicalPath} (${blockingConformance.ruleId})`
    );
  }
  const basename = input.logicalPath.split("/").at(-1) ?? "";
  if (basename === "index.md" || basename === "log.md") return [];
  const parsed = parseUploadedMarkdownSource({
    fileName: basename,
    content: input.body
  });
  const ownership = input.kind === "source" ? "source" : "focowiki";
  const analysis = analyzeOkfMetadata(parsed.metadata, {
    ownership,
    markdownBody: parsed.body
  });
  if (analysis.diagnostics.some((diagnostic) =>
    diagnostic.disposition === "blocking")) {
    throw new Error(`Storage vNext publication OKF 0.2 metadata is invalid: ${input.logicalPath}`);
  }
  return analysis.diagnostics;
}

const PROJECTION_CATALOG_FAMILIES = [
  ["manifest", "_index/manifest/v1/"],
  ["search", "_index/search/v1/"],
  ["links", "_index/links/v1/"],
  ["tree", "_index/tree/v1/"],
  ["graphNodes", "_graph/graph_node/v1/"],
  ["graphEdges", "_graph/graph_edge/v1/"]
] as const;

export function validateStorageVnextProjectionCatalogParity(input: {
  body: string;
  knowledgeBaseId: string;
  generationId: string;
  extensionResources: ReadonlySet<string>;
}): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body);
  } catch {
    throw new Error("Storage vNext projection catalog is invalid");
  }
  const catalog = requireRecord(parsed, "projection catalog");
  if (
    !hasExactKeys(catalog, [
      "formatVersion", "knowledgeBaseId", "generationId", "projections"
    ])
    || catalog.formatVersion !== 1
    || catalog.knowledgeBaseId !== input.knowledgeBaseId
    || catalog.generationId !== input.generationId
  ) throw new Error("Storage vNext projection catalog identity is inconsistent");
  const projections = requireRecord(catalog.projections, "projection catalog projections");
  const projectionKeys = [
    ...PROJECTION_CATALOG_FAMILIES.map(([publicName]) => publicName),
    "relatedFiles"
  ];
  if (!hasExactKeys(projections, projectionKeys)) {
    throw new Error("Storage vNext projection catalog shape is inconsistent");
  }
  for (const [publicName, prefix] of PROJECTION_CATALOG_FAMILIES) {
    const descriptor = requireRecord(projections[publicName], publicName);
    if (!hasExactKeys(descriptor, ["shards"]) || !Array.isArray(descriptor.shards)) {
      throw new Error(`Storage vNext projection catalog family is invalid: ${publicName}`);
    }
    const paths: string[] = [];
    for (const value of descriptor.shards) {
      const shard = requireRecord(value, `${publicName} shard`);
      if (
        !hasExactKeys(shard, ["path", "recordCount"])
        || typeof shard.path !== "string"
        || !shard.path.startsWith(prefix)
        || !isExtensionResourcePath(shard.path)
        || typeof shard.recordCount !== "number"
        || !Number.isSafeInteger(shard.recordCount)
        || shard.recordCount < 0
      ) throw new Error(`Storage vNext projection catalog shard is invalid: ${publicName}`);
      paths.push(shard.path);
    }
    if (new Set(paths).size !== paths.length) {
      throw new Error(`Storage vNext projection catalog shard is duplicated: ${publicName}`);
    }
    const expected = [...input.extensionResources]
      .filter((path) => path.startsWith(prefix))
      .sort(compareText);
    if (JSON.stringify([...paths].sort(compareText)) !== JSON.stringify(expected)) {
      throw new Error(`Storage vNext projection catalog parity is inconsistent: ${publicName}`);
    }
  }
  const relatedFiles = requireRecord(projections.relatedFiles, "relatedFiles");
  if (
    !hasExactKeys(relatedFiles, ["pathTemplate"])
    || relatedFiles.pathTemplate !== "_graph/by-file/{fileId}.json"
  ) throw new Error("Storage vNext by-file catalog template is inconsistent");
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Storage vNext ${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  return JSON.stringify(Object.keys(value).sort(compareText))
    === JSON.stringify([...expected].sort(compareText));
}

function validateNavigationGlobals(logicalPath: string, targets: readonly string[]): void {
  if (!isGeneratedNavigationMarkdown(logicalPath)) return;
  const actual = new Set(targets);
  const required = logicalPath === "index.md"
    ? ["pages/index.md", "_index/index.md", "_graph/index.md"]
    : logicalPath === "_index/index.md"
      ? ["index.md", "pages/index.md", "_graph/index.md"]
      : logicalPath === "_graph/index.md"
        ? ["index.md", "pages/index.md", "_index/index.md"]
        : ["index.md", "pages/index.md", "_index/index.md", "_graph/index.md"];
  if (required.some((target) => !actual.has(target))) {
    throw new Error(`Storage vNext reciprocal navigation is incomplete: ${logicalPath}`);
  }
}

function isGeneratedNavigationMarkdown(logicalPath: string): boolean {
  return logicalPath === "index.md"
    || /^pages(?:\/[^/]+)*\/index-(?!map-)[^/]+\.md$/u.test(logicalPath)
    || /^pages(?:\/[^/]+)*\/index\.md$/u.test(logicalPath)
    || logicalPath === "_index/index.md"
    || logicalPath === "_graph/index.md"
    || /^_(?:index|graph)\/.+\/index(?:-[^/]+)?\.md$/u.test(logicalPath);
}

function isExtensionNavigationMarkdown(logicalPath: string): boolean {
  return (logicalPath.startsWith("_index/") || logicalPath.startsWith("_graph/"))
    && logicalPath.endsWith(".md");
}

function isExtensionResourcePath(logicalPath: string): boolean {
  return /^_index\/(?:manifest|search|links|tree)\/v1\/[0-9]{4}\.json$/u.test(
    logicalPath
  ) || /^_graph\/(?:graph_node|graph_edge)\/v1\/[0-9]{4}\.json$/u.test(
    logicalPath
  ) || /^_graph\/by-file\/[^/]+\.json$/u.test(logicalPath);
}

function parseByFileEvidencePairs(markdown: string): Array<{
  resourcePath: string;
  evidencePath: string;
}> {
  const pairs = [];
  const pattern = /^- .*\]\((\/_graph\/by-file\/[^)]+\.json)\) · \[Source\]\((\/pages\/[^)]+\.md)\)$/gmu;
  for (const match of markdown.matchAll(pattern)) {
    pairs.push({
      resourcePath: decodeMarkdownPath(match[1]!),
      evidencePath: decodeMarkdownPath(match[2]!)
    });
  }
  return pairs;
}

function decodeByFileSourcePublicId(logicalPath: string): string {
  const encoded = logicalPath.slice("_graph/by-file/".length, -".json".length);
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new Error("Storage vNext by-file resource identity is invalid");
  }
}

function decodeMarkdownPath(href: string): string {
  try {
    return href.replace(/^\//u, "").split("/").map(decodeURIComponent).join("/");
  } catch {
    throw new Error("Storage vNext generated Markdown path is invalid");
  }
}

async function assertLinkTargets(
  input: Parameters<typeof createStorageVnextPublicationCandidateValidator>[0],
  request: { knowledgeBaseId: string; candidatePublicId: string },
  targets: readonly string[]
): Promise<void> {
  for (let offset = 0; offset < targets.length; offset += input.limits.maximumPageSize) {
    const logicalPaths = [...new Set(targets.slice(
      offset,
      offset + input.limits.maximumPageSize
    ))];
    const missing = await input.effectiveCatalog.findMissingLogicalPaths({
      ...request,
      logicalPaths
    });
    if (missing.length > 0) {
      throw new Error(`Storage vNext publication link target is missing: ${missing[0]}`);
    }
  }
}

async function validateShards(
  input: Parameters<typeof createStorageVnextPublicationCandidateValidator>[0],
  candidatePublicId: string
): Promise<ReadonlyMap<string, readonly PersistentDirectoryLeaf[]>> {
  const partsByDirectory = new Map<string, Array<ReturnType<
    typeof parseStorageVnextExtensionNavigationState
  >>>();
  let cursor: string | null = null;
  do {
    const page = await input.releases.listCandidateShards({
      candidatePublicId,
      limit: input.limits.maximumPageSize,
      cursor
    });
    const extensionParts = await mapWithConcurrency(
      page.items,
      input.limits.objectReadConcurrency,
      async (shard) => {
        if (!await input.objects.verify(shard)) {
          throw new Error("Storage vNext publication shard object is invalid");
        }
        if (shard.logicalKind !== STORAGE_VNEXT_EXTENSION_NAVIGATION_SHARD_KIND) {
          return null;
        }
        if (shard.firstLogicalPath !== shard.lastLogicalPath) {
          throw new Error("Storage vNext extension navigation shard scope is invalid");
        }
        const body = await input.objects.readText({
          objectId: shard.objectId,
          checksum: shard.checksum,
          byteCount: shard.byteCount,
          maximumBytes: input.limits.maximumMarkdownBytes
        });
        return {
          directoryPath: shard.firstLogicalPath,
          part: parseStorageVnextExtensionNavigationState({
            bytes: Buffer.from(body, "utf8"),
            directoryPath: shard.firstLogicalPath
          })
        };
      }
    );
    for (const parsed of extensionParts) {
      if (!parsed) continue;
      const parts = partsByDirectory.get(parsed.directoryPath) ?? [];
      parts.push(parsed.part);
      partsByDirectory.set(parsed.directoryPath, parts);
    }
    cursor = advancingCursor(cursor, page.nextCursor, "shard");
  } while (cursor !== null);
  const result = new Map<string, readonly PersistentDirectoryLeaf[]>();
  for (const directoryPath of STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES) {
    const parts = (partsByDirectory.get(directoryPath) ?? [])
      .sort((left, right) => left.partIndex - right.partIndex);
    if (
      parts.length === 0
      || parts.some((part, index) =>
        part.partIndex !== index || part.partCount !== parts.length)
    ) throw new Error(`Storage vNext extension navigation state is incomplete: ${directoryPath}`);
    const leaves = parts.flatMap((part) => part.leaves);
    validateStateIdentity(directoryPath, leaves);
    result.set(directoryPath, leaves);
  }
  if ([...partsByDirectory.keys()].some((directoryPath) =>
    !STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES.includes(
      directoryPath as (typeof STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES)[number]
    ))) throw new Error("Storage vNext extension navigation state scope is invalid");
  return result;
}

function validateStateIdentity(
  directoryPath: string,
  leaves: readonly PersistentDirectoryLeaf[]
): void {
  const leafIds = new Set<string>();
  const entryIds = new Set<string>();
  for (const leaf of leaves) {
    if (leafIds.has(leaf.id)) {
      throw new Error(`Storage vNext extension navigation leaf is duplicated: ${directoryPath}`);
    }
    leafIds.add(leaf.id);
    for (const entry of leaf.entries) {
      if (entryIds.has(entry.id)) {
        throw new Error(`Storage vNext extension navigation entry is duplicated: ${directoryPath}`);
      }
      entryIds.add(entry.id);
    }
  }
}

export function validateStorageVnextExtensionNavigationClosure(input: {
  documents: ReadonlyMap<string, readonly string[]>;
  resources: ReadonlySet<string>;
  state: ReadonlyMap<string, readonly PersistentDirectoryLeaf[]>;
}): void {
  for (const directoryPath of STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES) {
    const resources = [...input.resources].filter((path) =>
      parentPath(path) === directoryPath).sort(compareText);
    const leaves = input.state.get(directoryPath) ?? [];
    const rootPath = `${directoryPath}/index.md`;
    const rootTargets = input.documents.get(rootPath);
    if (resources.length === 0) {
      if (leaves.length > 0 || rootTargets) {
        throw new Error(`Storage vNext extension navigation retains an empty chain: ${directoryPath}`);
      }
      continue;
    }
    if (!rootTargets || leaves.length === 0) {
      throw new Error(`Storage vNext extension navigation chain is incomplete: ${directoryPath}`);
    }
    const leafById = new Map(leaves.map((leaf) => [leaf.id, leaf]));
    const heads = leaves.filter((leaf) => leaf.previousLeafId === null);
    if (heads.length !== 1) {
      throw new Error(`Storage vNext extension navigation chain head is invalid: ${directoryPath}`);
    }
    const expectedFirstPath = extensionLeafPath(directoryPath, heads[0]!.id);
    if (!rootTargets.includes(expectedFirstPath)) {
      throw new Error(`Storage vNext extension navigation root is inconsistent: ${directoryPath}`);
    }
    const visited = new Set<string>();
    let current: PersistentDirectoryLeaf | undefined = heads[0];
    let previous: PersistentDirectoryLeaf | null = null;
    while (current) {
      if (visited.has(current.id)) {
        throw new Error(`Storage vNext extension navigation chain contains a cycle: ${directoryPath}`);
      }
      visited.add(current.id);
      if (current.previousLeafId !== (previous?.id ?? null)) {
        throw new Error(`Storage vNext extension navigation previous link is invalid: ${directoryPath}`);
      }
      const logicalPath = extensionLeafPath(directoryPath, current.id);
      const targets = input.documents.get(logicalPath);
      if (!targets
        || !targets.includes(rootPath)
        || (current.previousLeafId !== null
          && !targets.includes(extensionLeafPath(directoryPath, current.previousLeafId)))
        || (current.nextLeafId !== null
          && !targets.includes(extensionLeafPath(directoryPath, current.nextLeafId)))) {
        throw new Error(`Storage vNext extension navigation leaf links are invalid: ${logicalPath}`);
      }
      previous = current;
      current = current.nextLeafId === null
        ? undefined
        : leafById.get(current.nextLeafId);
      if (previous.nextLeafId !== null && !current) {
        throw new Error(`Storage vNext extension navigation next link is invalid: ${directoryPath}`);
      }
    }
    if (visited.size !== leaves.length) {
      throw new Error(`Storage vNext extension navigation chain is disconnected: ${directoryPath}`);
    }
    const stateTargets = leaves.flatMap((leaf) =>
      leaf.entries.map((entry) => entry.targetPath)).sort(compareText);
    if (JSON.stringify(stateTargets) !== JSON.stringify(resources)) {
      throw new Error(`Storage vNext extension navigation summary is inconsistent: ${directoryPath}`);
    }
    const markdownLeaves = [...input.documents.keys()].filter((path) =>
      path.startsWith(`${directoryPath}/index-`));
    if (markdownLeaves.length !== leaves.length) {
      throw new Error(`Storage vNext extension navigation leaf coverage is inconsistent: ${directoryPath}`);
    }
  }
}

function extensionLeafPath(directoryPath: string, leafId: string): string {
  return `${directoryPath}/index-${leafId}.md`;
}

function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function countLinkDependencies(
  input: Parameters<typeof createStorageVnextPublicationCandidateValidator>[0],
  candidatePublicId: string
): Promise<number> {
  let cursor: string | null = null;
  let count = 0;
  do {
    const page = await input.releases.listCandidateDependencies({
      candidatePublicId,
      limit: input.limits.maximumPageSize,
      cursor
    });
    count += page.items.filter((item) => item.kind === "link").length;
    cursor = advancingCursor(cursor, page.nextCursor, "dependency");
  } while (cursor !== null);
  return count;
}

async function requireCandidate(
  releases: ReleasePort,
  request: { knowledgeBaseId: string; candidatePublicId: string }
) {
  const candidate = await releases.getLiveCandidate(request.knowledgeBaseId);
  if (!candidate || candidate.publicId !== request.candidatePublicId) {
    throw new Error("Storage vNext publication candidate is unavailable");
  }
  return candidate;
}

async function requireSearch(
  search: Parameters<typeof createStorageVnextPublicationCandidateValidator>[0]["search"],
  request: {
    knowledgeBaseId: string;
    searchProjectionPublicId: string;
  }
): Promise<{
  knowledgeBaseId: string;
  state: StorageVnextSearchProjectionState;
  documentCount: number;
}> {
  const candidate = await search.getProjection({
    knowledgeBaseId: request.knowledgeBaseId,
    publicId: request.searchProjectionPublicId
  });
  if (
    !candidate
    || candidate.knowledgeBaseId !== request.knowledgeBaseId
    || candidate.state !== "ready"
  ) throw new Error("Storage vNext unified search candidate is not ready");
  return candidate;
}

function advancingCursor(previous: string | null, next: string | null, kind: string) {
  if (next !== null && next === previous) {
    throw new Error(`Storage vNext publication ${kind} cursor did not advance`);
  }
  return next;
}

function validateLimits(limits: {
  maximumPageSize: number;
  maximumMarkdownBytes: number;
  objectReadConcurrency: number;
}) {
  if (
    !Number.isSafeInteger(limits.maximumPageSize)
    || limits.maximumPageSize < 1
    || limits.maximumPageSize > 1_000
    || !Number.isSafeInteger(limits.maximumMarkdownBytes)
    || limits.maximumMarkdownBytes < 1
    || !Number.isSafeInteger(limits.objectReadConcurrency)
    || limits.objectReadConcurrency < 1
    || limits.objectReadConcurrency > 32
  ) throw new Error("Storage vNext publication validation limits are invalid");
}

async function verifyUnreadEntry(
  objects: ObjectValidationPort,
  entry: Parameters<ObjectValidationPort["verify"]>[0]
): Promise<null> {
  if (!await objects.verify(entry)) {
    throw new Error("Storage vNext publication catalog entry is invalid");
  }
  return null;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  apply: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await apply(items[index]!);
      }
    }
  );
  await Promise.all(workers);
  return results;
}
