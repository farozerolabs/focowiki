import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import {
  portableByFileGraphDirectoryPath,
  portableByFileGraphPath,
  portableGraphDirectoryPath,
  portableIndexDirectoryPath
} from "../../packages/okf/src/index.js";
import {
  documentProjectionNavigationTerms,
  documentRelatedProjectionRecord,
  documentRelationProjectionRecord,
  documentSourceProjectionRecord
} from "../../apps/api/src/document-indexing/application/document-machine-record.js";
import {
  buildDocumentGraphCatalogPage,
  buildDocumentGraphDirectoryScopeResources,
  buildDocumentPerFileGraphScopeResource
} from "../../apps/api/src/document-indexing/application/document-graph-projection.js";
import {
  buildDocumentIndexCatalogPage,
  buildDocumentNavigationTermBucketResources,
  buildDocumentPageDirectoryScopeResources,
  buildDocumentTermCatalogPage
} from "../../apps/api/src/document-indexing/application/document-page-term-projection.js";
import { classifyDocumentNavigationTerm, type DocumentTermBucket } from
  "../../apps/api/src/document-indexing/application/document-term-routing.js";
import { createDocumentPortableAgentTraversal } from
  "../../apps/api/src/document-indexing/application/document-portable-agent-traversal.js";
import {
  collectDocumentGeneratedLinkPaths,
  validateDocumentGeneratedLinks
} from "../../apps/api/src/document-indexing/application/document-generated-link-validation.js";
import {
  renderDocumentDirectoryPages,
  renderDocumentRootPage
} from "../../apps/api/src/document-indexing/application/document-generated-navigation.js";
import { createNodeJiebaTokenizer } from
  "../../apps/api/src/infrastructure/tokenization/nodejieba-tokenizer.js";

const tokenizer = createNodeJiebaTokenizer();
const root = await mkdtemp(join(tmpdir(), "focowiki-portable-static-"));
const objects = new Map<string, Uint8Array>();
const sources = [
  source("overview.md", "Portable Overview",
    "# Portable Overview\n\nSee [安装指南](指南/安装.md) for setup."),
  source("指南/安装.md", "安装指南",
    "# 安装指南\n\n这份安装说明关联气候研究记录。"),
  source("research notes/climate.md", "Climate Notes",
    "# Climate Notes\n\nPortable climate research and multilingual navigation.")
];
const relations = [{
  fromPath: "overview.md", toPath: "指南/安装.md",
  fromTitle: "Portable Overview", toTitle: "安装指南",
  relationType: "references" as const, evidenceKind: "markdown_link" as const,
  evidenceValue: { href: "指南/安装.md" }
}, {
  fromPath: "指南/安装.md", toPath: "research notes/climate.md",
  fromTitle: "安装指南", toTitle: "Climate Notes",
  relationType: "references" as const, evidenceKind: "semantic" as const,
  evidenceValue: { reason: "The installation note identifies the climate record." }
}];

try {
  buildPortableObjects();
  const generatedPages = [...objects].filter(([path]) =>
    !path.startsWith("pages/")).map(([logicalPath, bytes]) => ({
      logicalPath, bytes, contentType: logicalPath.endsWith(".json")
        ? "application/json" : "text/markdown"
    }));
  validateDocumentGeneratedLinks({
    pages: generatedPages,
    activeLogicalPaths: collectDocumentGeneratedLinkPaths([...objects].map(
      ([logicalPath, bytes]) => ({ logicalPath, bytes,
        contentType: logicalPath.endsWith(".json")
          ? "application/json" : "text/markdown" })))
  });
  for (const [path, bytes] of objects) await persist(path, bytes);
  const files = (await listFiles(root)).sort(compareText);
  assert.equal(files.length, objects.size);
  for (const path of files) {
    const bytes = await readFile(join(root, ...path.split("/")));
    assert(bytes.equals(Buffer.from(objects.get(path)!)), path);
    if (path.endsWith(".json")) JSON.parse(bytes.toString("utf8"));
    if (!path.startsWith("pages/")) {
      const text = bytes.toString("utf8");
      assert(!/(?:source-file-|source-revision-|knowledge-base-|process:focowiki|\bFocowiki\b|\bschema\.md\b|https?:\/\/)/iu.test(text), path);
      assert(!/(?:^|\/)\d{4}\.json$/u.test(path), path);
    }
  }
  const localMatches = await searchCopiedMarkdown("portable climate research");
  assert.deepEqual(localMatches, ["pages/research notes/climate.md"]);
  const traversal = createDocumentPortableAgentTraversal({
    async readJson(path) {
      return JSON.parse(await readFile(join(root, ...path.split("/")), "utf8"));
    },
    maximumReads: 32
  });
  assert.equal((await traversal.exactPath("pages/指南/安装.md")).result?.title,
    "安装指南");
  assert((await traversal.term("安装")).result.some((item) =>
    item.path === "pages/指南/安装.md"));
  assert((await traversal.term("climate")).result.some((item) =>
    item.path === "pages/research notes/climate.md"));
  assert.equal((await traversal.term("missing portable term")).result.length, 0);
  assert.equal((await traversal.directory("pages/指南")).result.scopePath,
    "pages/指南");
  assert.equal((await traversal.relationships("pages/overview.md"))
    .result[0]?.targetPath, "pages/指南/安装.md");
  await verifyStaticHttp(files);
  process.stdout.write(`${JSON.stringify({
    kind: "portable-bundle-static-review",
    filesInspected: files.length,
    jsonFiles: files.filter((path) => path.endsWith(".json")).length,
    markdownFiles: files.filter((path) => path.endsWith(".md")).length,
    exactPath: true, multilingualTerms: true, directoryBrowse: true,
    noResult: true, relationshipExpansion: true, staticHttp: true,
    localMarkdownSearch: true, applicationAccess: false
  })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

function buildPortableObjects(): void {
  const records = sources.map((item) => documentSourceProjectionRecord({
    path: item.logicalPath, title: item.title, body: item.body,
    contentType: "text/markdown; charset=utf-8",
    checksumSha256: item.checksumSha256, byteCount: item.byteCount,
    metadata: { type: "document", title: item.title }, entities: []
  }, tokenizer, { hasRelationships: true }));
  const directories = directoryPaths(sources.map((item) =>
    `pages/${item.logicalPath}`));
  for (const scopePath of directories) {
    const childDirectories = directChildDirectories(directories, scopePath);
    const pageProjection = buildDocumentPageDirectoryScopeResources({
      scopePath,
      records: records.filter((record) => posix.dirname(String(record.path))
        === scopePath),
      childDirectories: childDirectories.map((path) => ({
        title: posix.basename(path), scopePath: path,
        path: `${portableIndexDirectoryPath(path)}/index.json`
      })),
      previousPaths: [], maximumRecordsPerShard: 2,
      maximumShardBytes: 16_384
    });
    storePages(pageProjection.pages);
    addMachineNavigation(portableIndexDirectoryPath(scopePath),
      pageProjection.pages, childDirectories.map((path) => ({
        scopePath: path, targetPath: `${portableIndexDirectoryPath(path)}/index.md`
      })));
    addPageNavigation(scopePath, childDirectories);
  }
  addTermResources(records);
  addGraphResources();
  for (const item of sources) objects.set(`pages/${item.logicalPath}`,
    Buffer.from(item.body, "utf8"));
  addRootResources();
}

function addTermResources(records: readonly Record<string, unknown>[]): void {
  const terms = new Map<DocumentTermBucket, Map<string, { path: string;
    fields: readonly string[] }[]>>();
  for (const record of records) for (const selected of
    documentProjectionNavigationTerms(record)) {
    const bucket = classifyDocumentNavigationTerm(selected.term);
    const bucketTerms = terms.get(bucket) ?? new Map();
    const postings = bucketTerms.get(selected.term) ?? [];
    postings.push({ path: String(record.path), fields: selected.fields });
    bucketTerms.set(selected.term, postings);
    terms.set(bucket, bucketTerms);
  }
  for (const [bucket, bucketTerms] of terms) {
    const projection = buildDocumentNavigationTermBucketResources({
      bucket,
      records: [...bucketTerms].sort(([left], [right]) =>
        compareText(left, right)).map(([term, postings]) => ({
          term,
          postings: postings.sort((left, right) => compareText(
            left.path, right.path))
        })),
      previousPaths: [], maximumRecordsPerShard: 2,
      maximumShardBytes: 16_384
    });
    storePages(projection.pages);
    addMachineNavigation(`_index/terms/${bucket}`, projection.pages, []);
  }
  storePage(buildDocumentTermCatalogPage([...terms.keys()]));
  addMachineNavigation("_index/terms", [{
    logicalPath: "_index/terms/index.json"
  }], [...terms.keys()].sort(compareText).map((bucket) => ({
    scopePath: `_index/terms/${bucket}`,
    targetPath: `_index/terms/${bucket}/index.md`
  })));
  storePage(buildDocumentIndexCatalogPage());
}

function addGraphResources(): void {
  const relationshipRecords = relations.map(documentRelationProjectionRecord);
  const relationshipDirectories = directoryPaths(relations.map((relation) =>
    `pages/${relation.fromPath}`));
  for (const scopePath of relationshipDirectories) {
    const children = directChildDirectories(relationshipDirectories, scopePath);
    const projection = buildDocumentGraphDirectoryScopeResources({
      scopePath,
      records: relationshipRecords.filter((record) =>
        posix.dirname(String(record.from)) === scopePath),
      childDirectories: children.map((path) => ({
        title: posix.basename(path), scopePath: path,
        path: `${portableGraphDirectoryPath(path)}/index.json`
      })),
      previousPaths: [], maximumRecordsPerShard: 2,
      maximumShardBytes: 16_384
    });
    storePages(projection.pages);
    addMachineNavigation(portableGraphDirectoryPath(scopePath), projection.pages,
      children.map((path) => ({ scopePath: path,
        targetPath: `${portableGraphDirectoryPath(path)}/index.md` })));
  }
  for (const item of sources) {
    const pagePath = `pages/${item.logicalPath}`;
    const related = relations.filter((relation) =>
      `pages/${relation.fromPath}` === pagePath
      || `pages/${relation.toPath}` === pagePath)
      .map((relation) => documentRelatedProjectionRecord(relation, pagePath));
    storePages(buildDocumentPerFileGraphScopeResource({
      source: { path: pagePath, title: item.title },
      relationships: related, previousPaths: []
    }).pages);
  }
  const byFileDirectories = directoryPaths(sources.map((item) =>
    `pages/${item.logicalPath}`));
  for (const scopePath of byFileDirectories) {
    const children = directChildDirectories(byFileDirectories, scopePath);
    addNavigation(portableByFileGraphDirectoryPath(scopePath), [
      ...sources.filter((item) => posix.dirname(`pages/${item.logicalPath}`)
        === scopePath).map((item) => navEntry(item.logicalPath, item.title,
        portableByFileGraphPath(`pages/${item.logicalPath}`), "file")),
      ...children.map((path) => navEntry(`directory:${path}`,
        posix.basename(path), `${portableByFileGraphDirectoryPath(path)}/index.md`,
        "directory"))
    ]);
  }
  storePage(buildDocumentGraphCatalogPage(relations.length));
}

function addRootResources(): void {
  const knowledgeBase = { id: "portable", name: "Portable Knowledge",
    description: "A copied portable bundle.", sourceFileCount: sources.length,
    graphEdgeCount: relations.length, changedAt: "2026-08-17T00:00:00.000Z" };
  for (const path of ["index.md", "log.md"] as const) storePage(
    renderDocumentRootPage({
      path, knowledgeBase, rootEntryCount: 3,
      currentLogEntry: { occurredAt: knowledgeBase.changedAt,
        action: "Updated pages", message: "Portable pages were updated." }
    }));
  addNavigation("_index", [
    navEntry("directory:_index/pages", "Documents", "_index/pages/index.md",
      "directory"),
    navEntry("_index/catalog.json", "Index catalog", "_index/catalog.json",
      "file"),
    navEntry("directory:_index/terms", "Navigation terms",
      "_index/terms/index.md", "directory")
  ], "Machine-readable indexes");
  addNavigation("_graph", [
    navEntry("directory:_graph/by-directory", "Relationships by directory",
      "_graph/by-directory/index.md", "directory"),
    navEntry("directory:_graph/by-file", "Relationships by file",
      "_graph/by-file/index.md", "directory"),
    navEntry("_graph/catalog.json", "Relationship catalog",
      "_graph/catalog.json", "file")
  ], "Relationship graph");
}

function addMachineNavigation(directoryPath: string,
  pages: readonly { logicalPath: string }[], children: readonly {
    scopePath: string; targetPath: string
  }[]): void {
  addNavigation(directoryPath, [
    ...pages.filter((page) => posix.dirname(page.logicalPath) === directoryPath)
      .map((page) => navEntry(page.logicalPath, posix.basename(page.logicalPath),
        page.logicalPath, "file")),
    ...children.map((child) => navEntry(`directory:${child.scopePath}`,
      posix.basename(child.scopePath), child.targetPath, "directory"))
  ]);
}

function addPageNavigation(scopePath: string, children: readonly string[]): void {
  addNavigation(scopePath, [
    ...sources.filter((item) => posix.dirname(`pages/${item.logicalPath}`)
      === scopePath).map((item) => navEntry(item.logicalPath, item.title,
      `pages/${item.logicalPath}`, "file")),
    ...children.map((path) => navEntry(`directory:${path}`,
      posix.basename(path), `${path}/index.md`, "directory"))
  ], scopePath === "pages" ? "Documents" : posix.basename(scopePath),
  "directory-leaf");
}

function addNavigation(directoryPath: string, entries: ReturnType<typeof navEntry>[],
  title = posix.basename(directoryPath), prefix = "extension-leaf"): void {
  const sorted = entries.sort((left, right) => compareText(left.sortKey,
    right.sortKey));
  assert(sorted.length > 0, directoryPath);
  const leafId = `${prefix}-${createHash("sha256").update(directoryPath)
    .digest("hex").slice(0, 16)}`;
  storePages(renderDocumentDirectoryPages({ directoryPath,
    entryCount: sorted.length, title,
    rootEntryKind: prefix === "directory-leaf" ? "directory" : "extension_version",
    leafEntryKind: prefix === "directory-leaf" ? "directory_leaf" : "extension_leaf",
    leaves: [{ id: leafId, previousLeafId: null, nextLeafId: null,
      revision: 1, entries: sorted }] }));
}

async function verifyStaticHttp(files: readonly string[]): Promise<void> {
  const server = createServer(async (request, response) => {
    try {
      const requestPath = decodeURIComponent(new URL(request.url ?? "/",
        "http://127.0.0.1").pathname).replace(/^\//u, "");
      assert(requestPath && !requestPath.includes(".."));
      response.end(await readFile(join(root, ...requestPath.split("/"))));
    } catch {
      response.statusCode = 404;
      response.end("Not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const indexLeaf = files.find((path) =>
      /^_index\/index-extension-leaf-[0-9a-f]+\.md$/u.test(path));
    const graphLeaf = files.find((path) =>
      /^_graph\/index-extension-leaf-[0-9a-f]+\.md$/u.test(path));
    assert(indexLeaf);
    assert(graphLeaf);
    for (const path of ["index.md", "_index/index.md", indexLeaf,
      "_graph/index.md", graphLeaf, "_index/catalog.json",
      "_index/pages/指南/index.json", "_index/terms/index.md",
      "_index/terms/han/index.md", "_graph/by-file/index.md",
      "_graph/by-file/指南/安装.json", "pages/指南/安装.md"]) {
      assert(files.includes(path), path);
      const response = await fetch(`${base}/${path.split("/")
        .map(encodeURIComponent).join("/")}`);
      assert.equal(response.status, 200, path);
    }
    const traversal = createDocumentPortableAgentTraversal({
      async readJson(path) {
        const response = await fetchPath(base, path);
        assert.equal(response.status, 200, path);
        return response.json() as Promise<Record<string, unknown>>;
      },
      maximumReads: 16
    });
    const exact = await traversal.exactPath("pages/指南/安装.md");
    assert.equal(exact.result?.path, "pages/指南/安装.md");
    const term = await traversal.term("climate");
    const canonicalPath = String(term.result[0]?.path ?? "");
    assert.equal(canonicalPath, "pages/research notes/climate.md");
    const sourceResponse = await fetchPath(base, canonicalPath);
    assert.equal(sourceResponse.status, 200);
    assert.match(await sourceResponse.text(), /Portable climate research/u);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
  }
}

async function searchCopiedMarkdown(query: string): Promise<string[]> {
  const normalized = query.toLocaleLowerCase("en-US");
  const matches: string[] = [];
  for (const path of await listFiles(join(root, "pages"), "pages")) {
    if (!path.endsWith(".md")) continue;
    const body = await readFile(join(root, ...path.split("/")), "utf8");
    if (body.toLocaleLowerCase("en-US").includes(normalized)) matches.push(path);
  }
  return matches.sort(compareText);
}

function fetchPath(base: string, path: string): Promise<Response> {
  return fetch(`${base}/${path.split("/").map(encodeURIComponent).join("/")}`);
}

function directoryPaths(pagePaths: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const pagePath of pagePaths) {
    let current = posix.dirname(pagePath);
    while (current !== ".") {
      directories.add(current);
      if (current === "pages") break;
      current = posix.dirname(current);
    }
  }
  return [...directories].sort(compareText);
}

function directChildDirectories(directories: readonly string[], parent: string) {
  return directories.filter((path) => path !== parent
    && posix.dirname(path) === parent);
}

function source(logicalPath: string, title: string, body: string) {
  return { logicalPath, title, body,
    checksumSha256: createHash("sha256").update(body).digest("hex"),
    byteCount: Buffer.byteLength(body) };
}

function navEntry(id: string, name: string, targetPath: string,
  kind: "file" | "directory") {
  return { id, name, targetPath, kind,
    sortKey: `${kind === "directory" ? "0" : "1"}/${name
      .toLocaleLowerCase("en-US")}/${id}` };
}

function storePages(pages: readonly { logicalPath: string; bytes: Uint8Array }[]) {
  for (const page of pages) storePage(page);
}

function storePage(page: { logicalPath: string; bytes: Uint8Array }) {
  objects.set(page.logicalPath, page.bytes);
}

async function persist(path: string, bytes: Uint8Array): Promise<void> {
  const target = join(root, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (item) => {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    return item.isDirectory() ? listFiles(join(directory, item.name), relative)
      : [relative];
  }))).flat();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
