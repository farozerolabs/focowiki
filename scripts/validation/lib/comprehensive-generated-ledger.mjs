import crypto from "node:crypto";

export const REQUIRED_GENERATED_NAVIGATION_PATHS = Object.freeze([
  "index.md",
  "pages/index.md",
  "schema.md",
  "log.md",
  "_index/index.md",
  "_graph/index.md",
  "_index/catalog.json"
]);

const PROJECTION_FAMILIES = Object.freeze([
  ["manifest", "_index/manifest/v1/"],
  ["search", "_index/search/v1/"],
  ["links", "_index/links/v1/"],
  ["tree", "_index/tree/v1/"],
  ["graphNodes", "_graph/graph_node/v1/"],
  ["graphEdges", "_graph/graph_edge/v1/"]
]);

export function assertGeneratedCatalog(entries, options) {
  const paths = new Set();
  const expectedSources = new Set(options.expectedSourceFileIds);
  const observedSources = new Set();
  if (expectedSources.size !== options.expectedSourceFileIds.length) {
    throw new Error("Generated catalog expected source identities contain a duplicate");
  }
  for (const entry of entries) {
    if (paths.has(entry.logicalPath)) {
      throw new Error(`${entry.alias}: generated catalog has a duplicate path`);
    }
    paths.add(entry.logicalPath);
    if (!isAllowedGeneratedPath(entry.logicalPath)) {
      throw new Error(`${entry.alias}: generated catalog path is invalid`);
    }
    if (/\/index-map-\d{6}\.md$/u.test(entry.logicalPath)) {
      throw new Error(`${entry.alias}: obsolete generated navigation remains`);
    }
    if (!/^[a-f0-9]{64}$/u.test(entry.checksumSha256)
      || !Number.isSafeInteger(entry.byteCount) || entry.byteCount < 1
      || !Number.isSafeInteger(entry.ordinal) || entry.ordinal < 0) {
      throw new Error(`${entry.alias}: generated catalog integrity fields are invalid`);
    }
    if (entry.objectState !== "verified") {
      throw new Error(`${entry.alias}: generated object is not verified`);
    }
    if (!Number.isSafeInteger(entry.ownerCount) || entry.ownerCount < 1) {
      throw new Error(`${entry.alias}: generated object has no active owner`);
    }
    if (entry.contentType !== contentTypeFor(entry.logicalPath)) {
      throw new Error(`${entry.alias}: generated content type is inconsistent`);
    }
    if (entry.kind === "source") {
      if (!entry.logicalPath.startsWith("pages/")
        || !entry.sourceFileId || !expectedSources.has(entry.sourceFileId)
        || observedSources.has(entry.sourceFileId)) {
        throw new Error(`${entry.alias}: generated source mapping is invalid or duplicate`);
      }
      observedSources.add(entry.sourceFileId);
    } else if (entry.sourceFileId !== null) {
      throw new Error(`${entry.alias}: non-source generated entry has a source mapping`);
    }
  }
  if (REQUIRED_GENERATED_NAVIGATION_PATHS.some((path) => !paths.has(path))) {
    throw new Error("Generated catalog required navigation is incomplete");
  }
  if ([...expectedSources].some((sourceId) => !observedSources.has(sourceId))) {
    throw new Error("Generated catalog source mapping is incomplete");
  }
  const requiredOrder = entries.slice(0, REQUIRED_GENERATED_NAVIGATION_PATHS.length)
    .map((entry) => entry.logicalPath);
  if (JSON.stringify(requiredOrder) !== JSON.stringify(REQUIRED_GENERATED_NAVIGATION_PATHS)) {
    throw new Error("Generated catalog required navigation order changed");
  }
  return {
    entryCount: entries.length,
    sourceEntryCount: observedSources.size,
    generatedEntryCount: entries.length - observedSources.size
  };
}

export function assertGeneratedContentClosure(entries, contents, options) {
  const paths = new Set(entries.map((entry) => entry.logicalPath));
  for (const entry of entries) {
    const observed = contents.get(entry.logicalPath);
    if (!observed || typeof observed.content !== "string" || observed.content.length === 0) {
      throw new Error(`${entry.alias}: generated content is missing`);
    }
    if (observed.apiByIdMatches !== true || observed.s3Matches !== true) {
      throw new Error(`${entry.alias}: generated API or S3 content diverged`);
    }
    if (Buffer.byteLength(observed.content, "utf8") !== entry.byteCount
      || sha256(observed.content) !== entry.checksumSha256) {
      throw new Error(`${entry.alias}: generated checksum or byte count diverged`);
    }
    assertSafeGeneratedText(observed.content, entry.alias);
    if (entry.logicalPath.endsWith(".json")) {
      parseJson(observed.content, entry.alias);
    } else if (entry.logicalPath.endsWith(".md")) {
      if (!/(?:^|\n)#\s+\S/u.test(observed.content)) {
        throw new Error(`${entry.alias}: generated Markdown heading is missing`);
      }
      if (entry.kind !== "source") {
        const targets = extractGeneratedMarkdownTargets(observed.content);
        for (const target of targets) {
          if (!paths.has(target)) {
            throw new Error(`${entry.alias}: generated link target is missing`);
          }
        }
        assertReciprocalNavigation(entry.logicalPath, targets, entry.alias);
      }
    }
  }
  const catalog = parseJson(contents.get("_index/catalog.json")?.content, "projection-catalog");
  assertProjectionCatalog(catalog, paths, contents, options);
  return { contentCount: contents.size, linkClosure: true, projectionParity: true };
}

export function assertGeneratedTreeClosure(input) {
  exactSet(input.adminFiles, input.catalogPaths, "Admin tree files");
  exactSet(input.openApiFiles, input.catalogPaths, "OpenAPI tree files");
  exactSet(input.adminDirectories, input.expectedDirectories, "Admin tree directories");
  exactSet(input.openApiDirectories, input.expectedDirectories, "OpenAPI tree directories");
  return {
    fileCount: input.catalogPaths.length,
    directoryCount: input.expectedDirectories.length
  };
}

export function assertGraphClosure(input) {
  if (!Number.isSafeInteger(input.relatedFileLimit)
    || input.relatedFileLimit < 1 || input.relatedFileLimit > 1_000) {
    throw new Error("Graph related-file limit is invalid");
  }
  const sources = uniqueMap(input.sources, "sourceFileId", "current source");
  const nodes = uniqueMap(input.nodes, "nodeId", "graph node");
  const nodeBySource = new Map();
  for (const node of nodes.values()) {
    const source = sources.get(node.sourceFileId);
    if (!source || node.revisionId !== source.revisionId
      || node.pagePath !== source.pagePath || !node.title?.trim()
      || nodeBySource.has(node.sourceFileId)) {
      throw new Error("Graph node is stale, foreign, duplicated, or path-inconsistent");
    }
    nodeBySource.set(node.sourceFileId, node);
  }
  if (nodeBySource.size !== sources.size) {
    throw new Error("Graph node coverage is incomplete");
  }
  const edges = uniqueMap(input.edges, "edgeId", "graph edge");
  const relationshipKeys = new Set();
  for (const edge of edges.values()) {
    const from = nodes.get(edge.fromNodeId);
    const to = nodes.get(edge.toNodeId);
    if (!from || !to) throw new Error("Graph edge endpoint is missing");
    if (edge.fromNodeId === edge.toNodeId || from.sourceFileId === to.sourceFileId) {
      throw new Error("Graph self edge is not allowed");
    }
    if (!edge.relation || !Number.isFinite(edge.weight)
      || edge.weight < 0 || edge.weight > 1) {
      throw new Error("Graph edge fields are invalid");
    }
    const key = `${edge.fromNodeId}\u0000${edge.toNodeId}\u0000${edge.relation}`;
    if (relationshipKeys.has(key)) throw new Error("Graph relationship is duplicated");
    relationshipKeys.add(key);
  }
  const evidenceByEdge = new Map([...edges.keys()].map((edgeId) => [edgeId, 0]));
  const evidenceIds = new Set();
  for (const evidence of input.evidence) {
    if (evidenceIds.has(evidence.evidenceId)) {
      throw new Error("Graph evidence is duplicated");
    }
    evidenceIds.add(evidence.evidenceId);
    if (Boolean(evidence.nodeId) === Boolean(evidence.edgeId)) {
      throw new Error("Graph evidence target is invalid");
    }
    if (evidence.nodeId && !nodes.has(evidence.nodeId)) {
      throw new Error("Graph evidence node is missing");
    }
    if (evidence.edgeId) {
      if (!edges.has(evidence.edgeId)) throw new Error("Graph evidence edge is missing");
      evidenceByEdge.set(evidence.edgeId, (evidenceByEdge.get(evidence.edgeId) ?? 0) + 1);
    }
    const source = sources.get(evidence.sourceFileId);
    if (!source || evidence.revisionId !== source.revisionId
      || evidence.pagePath !== source.pagePath
      || evidence.checksum !== source.checksum
      || !Number.isSafeInteger(evidence.startOffset)
      || !Number.isSafeInteger(evidence.endOffset)
      || evidence.startOffset < 0
      || evidence.endOffset < evidence.startOffset
      || evidence.endOffset > source.byteCount) {
      throw new Error("Graph evidence is stale, foreign, or outside its source");
    }
  }
  if ([...evidenceByEdge.values()].some((count) => count < 1)) {
    throw new Error("Graph edge has no grounded evidence");
  }

  exactSet(input.projectionRecords.search, [...sources.keys()], "search projection sources");
  exactSet(input.projectionRecords.manifest, [...sources.keys()], "manifest projection sources");
  exactSet(input.projectionRecords.graphNodes, [...sources.keys()], "graph node projection sources");
  exactSet(input.projectionRecords.graphEdges, [...edges.keys()], "graph edge projection records");
  exactSet(input.projectionRecords.links, [...edges.keys()], "link projection records");
  exactSet([...input.projectionRecords.byFile.keys()], [...sources.keys()], "by-file sources");
  const relationshipCandidates = new Map([...sources.keys()].map((sourceId) => [sourceId, []]));
  for (const edge of edges.values()) {
    const from = nodes.get(edge.fromNodeId);
    const to = nodes.get(edge.toNodeId);
    relationshipCandidates.get(from.sourceFileId).push({
      edgeId: edge.edgeId,
      fileId: to.sourceFileId,
      path: to.pagePath,
      title: to.title,
      relationType: edge.relation,
      direction: "outgoing",
      weight: edge.weight
    });
    relationshipCandidates.get(to.sourceFileId).push({
      edgeId: edge.edgeId,
      fileId: from.sourceFileId,
      path: from.pagePath,
      title: from.title,
      relationType: edge.relation,
      direction: "incoming",
      weight: edge.weight
    });
  }
  const expectedRelationships = new Set();
  for (const [sourceId, candidates] of relationshipCandidates) {
    const relatedTargets = new Set();
    const boundedNeighborhood = [...candidates]
      .sort(compareGraphNeighborhoodEdges)
      .slice(0, input.relatedFileLimit)
      .sort(compareGraphRelationships);
    for (const relationship of boundedNeighborhood) {
      const target = relationship.fileId || relationship.path;
      if (relatedTargets.has(target)) continue;
      relatedTargets.add(target);
      expectedRelationships.add(graphRelationshipKey(sourceId, relationship));
      if (relatedTargets.size >= input.relatedFileLimit) break;
    }
  }
  const observedRelationships = new Set();
  for (const [sourceId, relationships] of input.projectionRecords.byFile) {
    for (const relationship of relationships) {
      const key = graphRelationshipKey(sourceId, relationship);
      if (observedRelationships.has(key)) throw new Error("By-file relationship is duplicated");
      observedRelationships.add(key);
    }
  }
  exactSet([...observedRelationships], [...expectedRelationships], "by-file reverse relationships");
  return {
    sourceCount: sources.size,
    nodeCount: nodes.size,
    edgeCount: edges.size,
    evidenceCount: input.evidence.length,
    byFileRelationshipCount: observedRelationships.size
  };
}

function compareGraphNeighborhoodEdges(left, right) {
  return right.weight - left.weight || compareUtf8(left.edgeId, right.edgeId);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareGraphRelationships(left, right) {
  const leftDirection = left.direction === "outgoing" ? 0 : 1;
  const rightDirection = right.direction === "outgoing" ? 0 : 1;
  return right.weight - left.weight
    || leftDirection - rightDirection
    || left.title.localeCompare(right.title)
    || left.fileId.localeCompare(right.fileId);
}

function graphRelationshipKey(sourceId, relationship) {
  return `${sourceId}\u0000${relationship.fileId}\u0000${relationship.relationType}\u0000${relationship.direction}`;
}

export function classifyGeneratedPath(logicalPath, sourceBacked) {
  if (sourceBacked) return "source-page";
  if (REQUIRED_GENERATED_NAVIGATION_PATHS.includes(logicalPath)) return "required-navigation";
  if (logicalPath.startsWith("pages/") && logicalPath.endsWith(".md")) return "directory-navigation";
  if ((logicalPath.startsWith("_index/") || logicalPath.startsWith("_graph/"))
    && logicalPath.endsWith(".md")) return "extension-navigation";
  if (logicalPath.startsWith("_graph/by-file/") && logicalPath.endsWith(".json")) {
    return "graph-by-file";
  }
  if (logicalPath.startsWith("_index/") || logicalPath.startsWith("_graph/")) {
    return "projection-resource";
  }
  if (logicalPath.startsWith("_segments/")) return "immutable-segment";
  return "root-support";
}

function assertProjectionCatalog(catalog, paths, contents, options) {
  if (catalog?.formatVersion !== 1
    || catalog.knowledgeBaseId !== options.knowledgeBaseId
    || catalog.generationId !== options.generationId
    || !catalog.projections || typeof catalog.projections !== "object") {
    throw new Error("Projection catalog identity is inconsistent");
  }
  for (const [family, prefix] of PROJECTION_FAMILIES) {
    const shards = catalog.projections[family]?.shards;
    if (!Array.isArray(shards)) throw new Error("Projection catalog family is invalid");
    const observedPaths = [];
    for (const shard of shards) {
      if (typeof shard?.path !== "string" || !shard.path.startsWith(prefix)
        || !paths.has(shard.path) || !Number.isSafeInteger(shard.recordCount)
        || shard.recordCount < 0) {
        throw new Error("Projection catalog shard descriptor is invalid");
      }
      const body = parseJson(contents.get(shard.path)?.content, "projection-shard");
      if (!Array.isArray(body?.records) || body.records.length !== shard.recordCount) {
        throw new Error("Projection shard record count diverged");
      }
      observedPaths.push(shard.path);
    }
    if (new Set(observedPaths).size !== observedPaths.length) {
      throw new Error("Projection catalog shard path is duplicated");
    }
    const actual = [...paths].filter((path) => path.startsWith(prefix)
      && /^.*\/\d{4}\.json$/u.test(path));
    exactSet(observedPaths, actual, "projection catalog resources");
  }
  if (catalog.projections.relatedFiles?.pathTemplate !== "_graph/by-file/{fileId}.json") {
    throw new Error("Projection by-file template is invalid");
  }
}

function extractGeneratedMarkdownTargets(markdown) {
  const targets = [];
  const pattern = /(?:!?)\[[^\]\n]*\]\(([^\s)]+)(?:\s+[^)]*)?\)|^ {0,3}\[[^\]\n]+\]:\s*<?([^>\s]+)>?/gmu;
  for (const match of markdown.matchAll(pattern)) {
    const raw = match[1] ?? match[2];
    if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(raw)
      || raw.startsWith("//")) continue;
    const path = raw.split(/[?#]/u, 1)[0];
    if (!path?.startsWith("/")) continue;
    try {
      const decoded = path.replace(/^\/+/, "").split("/").map(decodeURIComponent).join("/");
      targets.push(decoded.endsWith("/") ? `${decoded}index.md` : decoded);
    } catch {
      throw new Error("Generated Markdown link encoding is invalid");
    }
  }
  return [...new Set(targets)];
}

function assertReciprocalNavigation(path, targets, alias) {
  if (!isNavigationMarkdown(path)) return;
  const targetSet = new Set(targets);
  const required = path === "index.md"
    ? ["pages/index.md", "_index/index.md", "_graph/index.md"]
    : path === "_index/index.md"
      ? ["index.md", "pages/index.md", "_graph/index.md"]
      : path === "_graph/index.md"
        ? ["index.md", "pages/index.md", "_index/index.md"]
        : ["index.md", "pages/index.md", "_index/index.md", "_graph/index.md"];
  if (required.some((target) => !targetSet.has(target))) {
    throw new Error(`${alias}: reciprocal navigation is incomplete`);
  }
}

function isNavigationMarkdown(path) {
  return path === "index.md"
    || /^pages(?:\/[^/]+)*\/index(?:-(?!map-)[^/]+)?\.md$/u.test(path)
    || path === "_index/index.md" || path === "_graph/index.md"
    || /^_(?:index|graph)\/.+\/index(?:-[^/]+)?\.md$/u.test(path);
}

function isAllowedGeneratedPath(path) {
  if (typeof path !== "string" || path.length < 1 || path.startsWith("/")
    || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    return false;
  }
  if (/^(?:index|log(?:-\d{6})?|schema(?:-[a-z0-9-]+)?)(?:-\d{6})?\.md$/u.test(path)) return true;
  if (path.startsWith("pages/") && path.endsWith(".md")) return true;
  if (path === "_index/index.md" || path === "_index/catalog.json"
    || path === "_graph/index.md") return true;
  if (/^_index\/(?:manifest|search|links|tree)\/(?:index\.md|v1\/(?:index(?:-[^/]+)?\.md|\d{4}\.json))$/u.test(path)) return true;
  if (/^_graph\/(?:graph_node|graph_edge)\/(?:index\.md|v1\/(?:index(?:-[^/]+)?\.md|\d{4}\.json))$/u.test(path)) return true;
  if (/^_graph\/by-file\/(?:index(?:-[^/]+)?\.md|[^/]+\.json)$/u.test(path)) return true;
  return /^_segments\/.+\.json$/u.test(path);
}

function contentTypeFor(path) {
  if (path.endsWith(".jsonl")) return "application/x-ndjson; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/markdown; charset=utf-8";
}

function assertSafeGeneratedText(content, alias) {
  const forbidden = [
    /\bS3_[A-Z0-9_]*\b/u,
    /\bs3:\/\/[^\s)]+/iu,
    /\/Users\/[^\s)]+/u,
    /\/private\/[^\s)]+/u,
    /\bbaselineRunId\b/u,
    /\bderivativeRunId\b/u
  ];
  if (forbidden.some((pattern) => pattern.test(content))) {
    throw new Error(`${alias}: generated content exposes internal data`);
  }
}

function parseJson(value, label) {
  if (typeof value !== "string") throw new Error(`${label}: JSON content is missing`);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label}: JSON content is invalid`);
  }
}

function uniqueMap(rows, key, label) {
  const output = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!value || output.has(value)) throw new Error(`${label} identity is missing or duplicated`);
    output.set(value, row);
  }
  return output;
}

function exactSet(actual, expected, label) {
  if (new Set(actual).size !== actual.length || new Set(expected).size !== expected.length) {
    throw new Error(`${label} contains a duplicate`);
  }
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((item) => !actualSet.has(item)).length;
  const foreign = actual.filter((item) => !expectedSet.has(item)).length;
  if (actual.length !== expected.length || missing > 0 || foreign > 0) {
    throw new Error(
      `${label} is incomplete or contains a foreign item `
      + `(expected=${expected.length},observed=${actual.length},missing=${missing},foreign=${foreign})`
    );
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
