import { createHash } from "node:crypto";
import { resolveSourceMarkdownLinkDestination } from "@focowiki/okf";
import { generatedPagePath } from "../../domain/source-path.js";
import type { StorageVnextStructuredMetadata } from "../shared/types.js";
import type {
  StorageVnextGraphEdgeFact,
  StorageVnextGraphEvidence,
  StorageVnextGraphNodeFact
} from "./ports.js";
import { MAX_STORAGE_VNEXT_GRAPH_EVIDENCE_REFS } from "./ports.js";

export type StorageVnextGraphFactMappingErrorCode =
  | "invalid_input"
  | "checksum_mismatch";

export class StorageVnextGraphFactMappingError extends Error {
  public constructor(public readonly code: StorageVnextGraphFactMappingErrorCode) {
    super(`Storage vNext graph fact mapping error: ${code}`);
    this.name = "StorageVnextGraphFactMappingError";
  }
}

export type StorageVnextMarkdownGraphTarget = {
  nodePublicId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
  label: string;
};

export function mapStorageVnextMarkdownGraph(input: {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  sourceLogicalPath: string;
  body: string;
  checksum: string;
  fallbackTitle: string;
  metadata: StorageVnextStructuredMetadata;
  targets: readonly StorageVnextMarkdownGraphTarget[];
  revision: number;
}): {
  node: StorageVnextGraphNodeFact;
  edges: StorageVnextGraphEdgeFact[];
} {
  validateInput(input);
  const bodyChecksum = createHash("sha256").update(input.body, "utf8").digest("hex");
  if (bodyChecksum !== input.checksum) {
    throw new StorageVnextGraphFactMappingError("checksum_mismatch");
  }
  const logicalPath = generatedPagePath(input.sourceLogicalPath);
  const heading = findFirstHeading(input.body);
  const label = heading?.label ?? input.fallbackTitle.trim();
  if (!label) throw new StorageVnextGraphFactMappingError("invalid_input");
  const nodePublicId = stablePublicId("graph-node-v1", [
    input.knowledgeBaseId,
    input.sourceFilePublicId
  ]);
  const nodeEvidence = heading
    ? [createEvidence({
        targetKind: "node",
        targetPublicId: nodePublicId,
        sourceFilePublicId: input.sourceFilePublicId,
        sourceRevisionPublicId: input.sourceRevisionPublicId,
        logicalPath,
        startOffset: heading.startOffset,
        endOffset: heading.endOffset,
        checksum: input.checksum
      })]
    : [];
  const node: StorageVnextGraphNodeFact = {
    publicId: nodePublicId,
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFilePublicId: input.sourceFilePublicId,
    sourceRevisionPublicId: input.sourceRevisionPublicId,
    logicalPath,
    label,
    kind: metadataKind(input.metadata),
    metadata: input.metadata,
    evidence: nodeEvidence,
    revision: input.revision
  };

  const targets = new Map(
    input.targets.map((target) => [normalizeGeneratedPath(target.logicalPath), target])
  );
  const links = findMarkdownLinks(input.body, input.sourceLogicalPath);
  const edges = new Map<string, StorageVnextGraphEdgeFact>();
  for (const link of links) {
    const target = targets.get(link.logicalPath);
    if (!target || target.nodePublicId === nodePublicId) continue;
    const publicId = stablePublicId("graph-edge-v1", [
      input.knowledgeBaseId,
      nodePublicId,
      target.nodePublicId,
      "direct_reference"
    ]);
    const evidence = createEvidence({
      targetKind: "edge",
      targetPublicId: publicId,
      sourceFilePublicId: input.sourceFilePublicId,
      sourceRevisionPublicId: input.sourceRevisionPublicId,
      logicalPath,
      startOffset: link.startOffset,
      endOffset: link.endOffset,
      checksum: input.checksum
    });
    const current = edges.get(target.nodePublicId);
    if (current) {
      if (current.evidence.length < MAX_STORAGE_VNEXT_GRAPH_EVIDENCE_REFS) {
        current.evidence = [...current.evidence, evidence];
      }
      continue;
    }
    edges.set(target.nodePublicId, {
      publicId,
      knowledgeBaseId: input.knowledgeBaseId,
      fromNodePublicId: nodePublicId,
      toNodePublicId: target.nodePublicId,
      relation: "direct_reference",
      weight: 1,
      reason: `${label} links to ${target.label}.`,
      source: "deterministic",
      metadata: {
        signal: "direct_reference",
        targetPath: target.logicalPath,
        targetTitle: target.label
      },
      evidence: [evidence],
      revision: input.revision
    });
  }
  return { node, edges: [...edges.values()] };
}

function validateInput(input: {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  sourceLogicalPath: string;
  checksum: string;
  fallbackTitle: string;
  targets: readonly StorageVnextMarkdownGraphTarget[];
  revision: number;
}): void {
  if (
    !input.knowledgeBaseId
    || !input.sourceFilePublicId
    || !input.sourceRevisionPublicId
    || !input.sourceLogicalPath
    || !/^[0-9a-f]{64}$/u.test(input.checksum)
    || !Number.isSafeInteger(input.revision)
    || input.revision < 0
    || input.targets.length > 1_000
  ) {
    throw new StorageVnextGraphFactMappingError("invalid_input");
  }
}

function metadataKind(metadata: StorageVnextStructuredMetadata): string {
  const value = metadata.type;
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 128)
    : "page";
}

function findFirstHeading(body: string): {
  label: string;
  startOffset: number;
  endOffset: number;
} | null {
  let offset = 0;
  let activeFence: string | null = null;
  for (const line of body.split("\n")) {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1] ?? null;
    if (fence) {
      if (!activeFence) activeFence = fence[0] ?? null;
      else if (fence[0] === activeFence) activeFence = null;
    } else if (!activeFence) {
      const match = line.match(/^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/u);
      const label = match?.[1]?.trim() ?? "";
      if (label) {
        return {
          label,
          startOffset: offset,
          endOffset: offset + line.length
        };
      }
    }
    offset += line.length + 1;
  }
  return null;
}

function findMarkdownLinks(
  body: string,
  sourceLogicalPath: string
): Array<{ logicalPath: string; startOffset: number; endOffset: number }> {
  const links: Array<{
    logicalPath: string;
    startOffset: number;
    endOffset: number;
  }> = [];
  let bodyOffset = 0;
  let activeFence: string | null = null;
  for (const line of body.split("\n")) {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1] ?? null;
    if (fence) {
      if (!activeFence) activeFence = fence[0] ?? null;
      else if (fence[0] === activeFence) activeFence = null;
      bodyOffset += line.length + 1;
      continue;
    }
    if (!activeFence) {
      for (const segment of outsideInlineCode(line)) {
        const pattern = /\[[^\]\n]+\]\((<?[^\s)>\n]+>?)(?:\s+["'][^"'\n]*["'])?\)/gu;
        for (const match of segment.text.matchAll(pattern)) {
          const matchOffset = match.index;
          if (segment.text[matchOffset - 1] === "!") continue;
          const destination = match[1] ?? "";
          const resolved = resolveSourceMarkdownLinkDestination(
            destination,
            sourceLogicalPath
          );
          const logicalPath = normalizeResolvedLink(resolved);
          if (!logicalPath) continue;
          links.push({
            logicalPath,
            startOffset: bodyOffset + segment.startOffset + matchOffset,
            endOffset:
              bodyOffset + segment.startOffset + matchOffset + match[0].length
          });
        }
      }
    }
    bodyOffset += line.length + 1;
  }
  return links;
}

function outsideInlineCode(line: string): Array<{
  text: string;
  startOffset: number;
}> {
  const output: Array<{ text: string; startOffset: number }> = [];
  let offset = 0;
  let codeDelimiter: string | null = null;
  while (offset < line.length) {
    const tickStart = line.indexOf("`", offset);
    if (tickStart < 0) {
      if (!codeDelimiter && offset < line.length) {
        output.push({ text: line.slice(offset), startOffset: offset });
      }
      break;
    }
    if (!codeDelimiter && tickStart > offset) {
      output.push({ text: line.slice(offset, tickStart), startOffset: offset });
    }
    let tickEnd = tickStart + 1;
    while (line[tickEnd] === "`") tickEnd += 1;
    const delimiter = line.slice(tickStart, tickEnd);
    if (!codeDelimiter) codeDelimiter = delimiter;
    else if (codeDelimiter === delimiter) codeDelimiter = null;
    offset = tickEnd;
  }
  return output;
}

function normalizeResolvedLink(value: string): string | null {
  if (!value.startsWith("/pages/")) return null;
  const suffix = Math.min(
    ...[value.indexOf("?"), value.indexOf("#")]
      .filter((index) => index >= 0),
    value.length
  );
  const path = value.slice(1, suffix);
  try {
    return path
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    return null;
  }
}

function normalizeGeneratedPath(value: string): string {
  return value.startsWith("/") ? value.slice(1) : value;
}

function createEvidence(input: {
  targetKind: "node" | "edge";
  targetPublicId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
  startOffset: number;
  endOffset: number;
  checksum: string;
}): StorageVnextGraphEvidence {
  return {
    publicId: stablePublicId("graph-evidence-v1", [
      input.targetKind,
      input.targetPublicId,
      input.sourceFilePublicId,
      input.sourceRevisionPublicId,
      input.logicalPath,
      String(input.startOffset),
      String(input.endOffset),
      input.checksum
    ]),
    sourceFilePublicId: input.sourceFilePublicId,
    sourceRevisionPublicId: input.sourceRevisionPublicId,
    logicalPath: input.logicalPath,
    startOffset: input.startOffset,
    endOffset: input.endOffset,
    checksum: input.checksum
  };
}

function stablePublicId(kind: string, values: string[]): string {
  return `${kind}:${createHash("sha256")
    .update([kind, ...values].join("\u0000"))
    .digest("hex")}`;
}
