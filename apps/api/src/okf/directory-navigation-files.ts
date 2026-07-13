import {
  directoryIndexMapDescriptor,
  directoryIndexPageDescriptor,
  generatedConceptFrontmatter,
  toBundleMarkdownHref,
  type GeneratedConceptDescriptor,
  type SourceMetadata
} from "@focowiki/okf";
import type { ReleaseNavigationEntryRecord } from "../application/ports/release-publication-repository.js";
import type { CursorPage, CursorPageRequest } from "../runtime/bounded.js";
import type { GeneratedOkfFile } from "./publication-files.js";

type NavigationEntry = {
  kind: "directory" | "file";
  name: string;
  path: string;
  label: string;
  description: string | null;
};

type NavigationShard = {
  path: string;
  label: string;
  count: number;
};

type DirectoryStreamState = {
  directoryPath: string;
  expectedEntryCount: number;
  seenEntryCount: number;
  pageIndex: number;
  entries: NavigationEntry[];
  entriesByteLength: number;
  shards: NavigationShard[];
  sharded: boolean;
};

const DEFAULT_PAGE_ENTRIES = 200;
const DEFAULT_PAGE_BYTES = 65_536;

export async function writeDirectoryNavigationFiles(input: {
  generatedAt: string;
  pageSize: number;
  maxEntriesPerPage?: number;
  maxBytesPerPage?: number;
  fetchEntryPage: (
    request: CursorPageRequest
  ) => Promise<CursorPage<ReleaseNavigationEntryRecord>>;
  writeFiles: (files: GeneratedOkfFile[]) => Promise<void>;
}): Promise<number> {
  const maxEntries = normalizePageSize(input.maxEntriesPerPage);
  const maxBytes = normalizeByteSize(input.maxBytesPerPage);
  let cursor: string | null = null;
  let state: DirectoryStreamState | null = null;
  let fileCount = 0;

  do {
    const page = await input.fetchEntryPage({ cursor, limit: input.pageSize });
    for (const item of page.items) {
      if (item.kind === "directory_start") {
        if (state) {
          fileCount += await finishDirectory(input, state, maxEntries, maxBytes);
        }
        state = createDirectoryState(item);
        continue;
      }
      if (!state || state.directoryPath !== item.parentPath) {
        throw new Error("Directory navigation entry is missing its directory boundary");
      }
      const entry = {
        kind: item.kind,
        name: item.name,
        path: bundlePath(
          state.directoryPath,
          item.kind === "directory" && !item.targetPath.endsWith("/index.md")
            ? `${item.targetPath.replace(/\/$/u, "")}/index.md`
            : item.targetPath
        ),
        label: navigationLabel(item),
        description: navigationDescription(item)
      } satisfies NavigationEntry;
      const entryByteLength = navigationEntryByteLength(entry);
      if (
        state.entries.length > 0
        && (state.entries.length >= maxEntries
          || state.entriesByteLength + 1 + entryByteLength > maxBytes)
      ) {
        fileCount += await flushEntryShard(input, state);
      }
      state.entries.push(entry);
      state.entriesByteLength += (state.entries.length > 1 ? 1 : 0) + entryByteLength;
      state.seenEntryCount += 1;
    }
    cursor = page.nextCursor;
  } while (cursor);

  if (state) {
    fileCount += await finishDirectory(input, state, maxEntries, maxBytes);
  }
  return fileCount;
}

function createDirectoryState(item: ReleaseNavigationEntryRecord): DirectoryStreamState {
  const expectedEntryCount = item.entryCount ?? 0;
  return {
    directoryPath: item.parentPath,
    expectedEntryCount,
    seenEntryCount: 0,
    pageIndex: 0,
    entries: [],
    entriesByteLength: 0,
    shards: [],
    sharded: false
  };
}

async function finishDirectory(
  input: Parameters<typeof writeDirectoryNavigationFiles>[0],
  state: DirectoryStreamState,
  maxEntries: number,
  maxBytes: number
): Promise<number> {
  if (state.seenEntryCount !== state.expectedEntryCount) {
    throw new Error(`Directory navigation count changed during publication: ${state.directoryPath}`);
  }
  if (
    !state.sharded
    && state.entries.length <= maxEntries
    && navigationEntriesByteLength(state.entries) <= maxBytes
  ) {
    await input.writeFiles([
      navigationFile(
        `${state.directoryPath}/index.md`,
        "directory_index",
        renderReservedIndex(directoryTitle(state.directoryPath), state.entries)
      )
    ]);
    return 1;
  }

  let written = 0;
  if (state.entries.length > 0) {
    written += await flushEntryShard(input, state);
  }
  if (
    state.shards.length <= maxEntries
    && navigationEntriesByteLength(state.shards.map(shardNavigationEntry)) <= maxBytes
  ) {
    await input.writeFiles([
      navigationFile(
        `${state.directoryPath}/index.md`,
        "directory_index",
        renderReservedIndex(
          `${directoryTitle(state.directoryPath)} index`,
          state.shards.map(shardNavigationEntry)
        )
      )
    ]);
    return written + 1;
  }

  const mapChunks = partitionByBudget(
    state.shards,
    maxEntries,
    maxBytes,
    shardNavigationEntry
  );
  const mapPages = mapChunks.map((shards, index) => {
    const page = index + 1;
    const descriptor = directoryIndexMapDescriptor({
      directoryPath: state.directoryPath,
      directoryTitle: directoryTitle(state.directoryPath),
      page,
      pageCount: mapChunks.length
    });
    return {
      descriptor,
      file: navigationFile(
        descriptor.path,
        "directory_index_map",
        renderConceptNavigation({
        descriptor,
        generatedAt: input.generatedAt,
        page,
        pageCount: mapChunks.length,
        body: renderEntryList(shards.map(shardNavigationEntry)),
        rootPath: bundlePath(state.directoryPath, "index.md"),
        previousPath: page > 1
          ? bundlePath(state.directoryPath, `index-map-${pad(page - 1)}.md`)
          : null,
        nextPath: page < mapChunks.length
          ? bundlePath(state.directoryPath, `index-map-${pad(page + 1)}.md`)
          : null
        }),
        generatedConceptFrontmatter(descriptor)
      )
    };
  });
  const mapEntries = mapPages.map(({ descriptor }) => ({
    kind: "file" as const,
    name: basename(descriptor.path),
    path: `/${descriptor.path}`,
    label: descriptor.navigationLabel,
    description: descriptor.description
  }));
  await input.writeFiles([
    navigationFile(
      `${state.directoryPath}/index.md`,
      "directory_index",
      renderReservedIndex(`${directoryTitle(state.directoryPath)} index`, mapEntries)
    ),
    ...mapPages.map(({ file }) => file)
  ]);
  return written + mapPages.length + 1;
}

async function flushEntryShard(
  input: Parameters<typeof writeDirectoryNavigationFiles>[0],
  state: DirectoryStreamState
): Promise<number> {
  state.sharded = true;
  state.pageIndex += 1;
  const page = state.pageIndex;
  const start = state.shards.reduce((count, shard) => count + shard.count, 0) + 1;
  const end = start + state.entries.length - 1;
  const descriptor = directoryIndexPageDescriptor({
    directoryPath: state.directoryPath,
    directoryTitle: directoryTitle(state.directoryPath),
    page,
    start,
    end
  });
  await input.writeFiles([
    navigationFile(
      descriptor.path,
      "directory_index_page",
      renderConceptNavigation({
        descriptor,
        generatedAt: input.generatedAt,
        page,
        pageCount: null,
        body: renderEntryList(state.entries),
        rootPath: bundlePath(state.directoryPath, "index.md"),
        previousPath: page > 1
          ? bundlePath(state.directoryPath, `index-${pad(page - 1)}.md`)
          : null,
        nextPath: state.seenEntryCount < state.expectedEntryCount
          ? bundlePath(state.directoryPath, `index-${pad(page + 1)}.md`)
          : null
      }),
      generatedConceptFrontmatter(descriptor)
    )
  ]);
  state.shards.push({
    path: `/${descriptor.path}`,
    label: descriptor.navigationLabel,
    count: state.entries.length
  });
  state.entries = [];
  state.entriesByteLength = 0;
  return 1;
}

function navigationFile(
  logicalPath: string,
  fileKind: "directory_index" | "directory_index_page" | "directory_index_map",
  content: string,
  metadata: SourceMetadata | null = null
): GeneratedOkfFile {
  return { logicalPath, sourceFileId: null, fileKind, content, metadata };
}

function renderReservedIndex(title: string, entries: NavigationEntry[]): string {
  return `# ${escapeLabel(title)}\n\n${renderEntryList(entries)}\n`;
}

function renderEntryList(entries: NavigationEntry[]): string {
  return entries
    .map((entry) => {
      const link = `- [${escapeLabel(entry.label)}](${toBundleMarkdownHref(entry.path)})`;
      return entry.description ? `${link} - ${escapeDescription(entry.description)}` : link;
    })
    .join("\n");
}

function renderConceptNavigation(input: {
  descriptor: GeneratedConceptDescriptor;
  generatedAt: string;
  page: number;
  pageCount: number | null;
  body: string;
  rootPath: string;
  previousPath: string | null;
  nextPath: string | null;
}): string {
  const navigation = [
    `[Directory index](${toBundleMarkdownHref(input.rootPath)})`,
    ...(input.previousPath ? [`[Previous](${toBundleMarkdownHref(input.previousPath)})`] : []),
    ...(input.nextPath ? [`[Next](${toBundleMarkdownHref(input.nextPath)})`] : [])
  ].join(" · ");
  return [
    "---",
    `type: ${JSON.stringify(input.descriptor.type)}`,
    `title: ${JSON.stringify(input.descriptor.title)}`,
    `description: ${JSON.stringify(input.descriptor.description)}`,
    `timestamp: ${JSON.stringify(input.generatedAt)}`,
    `page: ${input.page}`,
    ...(input.pageCount === null ? [] : [`page_count: ${input.pageCount}`]),
    "navigation_only: true",
    "---",
    `# ${escapeLabel(input.descriptor.heading)}`,
    "",
    navigation,
    "",
    input.body,
    ""
  ].join("\n");
}

function shardNavigationEntry(shard: NavigationShard): NavigationEntry {
  return {
    kind: "file",
    name: shard.path,
    path: shard.path,
    label: shard.label,
    description: `Contains ${shard.count} direct entries.`
  };
}

function navigationLabel(item: ReleaseNavigationEntryRecord): string {
  const title = cleanInlineText(item.title) || cleanInlineText(item.label) || item.name;
  if (item.kind !== "file" || (item.duplicateTitleCount ?? 1) <= 1) {
    return title;
  }

  const timestamp = cleanInlineText(item.timestamp);
  const version = cleanInlineText(item.version);
  const uniqueTimestamp = timestamp && (item.duplicateTimestampCount ?? 1) <= 1
    ? timestamp.slice(0, 10)
    : "";
  const uniqueVersion = version && (item.duplicateVersionCount ?? 1) <= 1 ? version : "";
  const discriminator = uniqueTimestamp || uniqueVersion || filenameDiscriminator(item.name);
  return discriminator && discriminator !== title ? `${title} (${discriminator})` : title;
}

function navigationDescription(item: ReleaseNavigationEntryRecord): string | null {
  if (item.kind === "directory") {
    const count = item.directChildCount;
    return Number.isSafeInteger(count) && (count ?? -1) >= 0
      ? `Contains ${count} direct ${count === 1 ? "entry" : "entries"}.`
      : "Browse this directory.";
  }
  return cleanInlineText(item.description) || "Read this Markdown concept.";
}

function cleanInlineText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
}

function filenameStem(value: string): string {
  return value.replace(/\.md$/iu, "");
}

function filenameDiscriminator(value: string): string {
  const stem = filenameStem(value);
  return stem.split("__").filter(Boolean).at(-1) || stem;
}

function directoryTitle(path: string): string {
  return path === "pages" ? "Pages" : basename(path);
}

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function bundlePath(directoryPath: string, targetPath: string): string {
  return `/${[directoryPath, targetPath].filter(Boolean).join("/")}`;
}

function escapeLabel(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function escapeDescription(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function pad(value: number): string {
  return String(value).padStart(6, "0");
}

function normalizePageSize(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? value as number
    : DEFAULT_PAGE_ENTRIES;
}

function normalizeByteSize(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? value as number
    : DEFAULT_PAGE_BYTES;
}

function navigationEntriesByteLength(entries: NavigationEntry[]): number {
  return new TextEncoder().encode(renderEntryList(entries)).byteLength;
}

function navigationEntryByteLength(entry: NavigationEntry): number {
  return new TextEncoder().encode(renderEntryList([entry])).byteLength;
}

function partitionByBudget<T>(
  values: T[],
  maxEntries: number,
  maxBytes: number,
  toEntry: (value: T) => NavigationEntry
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];

  for (const value of values) {
    const candidate = [...current, value];
    if (
      current.length > 0
      && (candidate.length > maxEntries
        || navigationEntriesByteLength(candidate.map(toEntry)) > maxBytes)
    ) {
      chunks.push(current);
      current = [];
    }
    current.push(value);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
