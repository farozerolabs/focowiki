import { createHash } from "node:crypto";
import type { LexicalTokenizer } from
  "../../application/ports/lexical-tokenizer.js";
import { buildSourceContentProfile } from
  "../../graph/content-profile.js";
import { analyzeDocumentSourceMarkdown } from
  "../domain/document-source-metadata.js";
import {
  buildDocumentReferenceProfile,
  buildDocumentStructureProfile
} from "../domain/document-source-profiles.js";

const MAXIMUM_PROFILE_BYTES = 262_144;

export type DocumentSourceBodyReadPort = {
  readVerifiedStream(request: {
    objectId: string;
    checksum: string;
    byteCount: number;
    contentType: string;
    maxBytes: number;
    signal?: AbortSignal;
  }): Promise<AsyncIterable<Uint8Array>>;
};

export type DocumentProfileArtifactReference = {
  objectId: string;
  checksumSha256: string;
  byteCount: number;
};

export type DocumentProfileArtifactStore = {
  putVerifiedJson(input: {
    artifactKind: "content_profile" | "structure_profile" | "reference_profile";
    contractSha256: string;
    checksumSha256: string;
    byteCount: number;
    bytes: Uint8Array;
    signal: AbortSignal;
  }): Promise<DocumentProfileArtifactReference>;
};

export function createDocumentSourcePreparation(input: {
  bodyStore: DocumentSourceBodyReadPort;
  tokenizer: LexicalTokenizer;
  profiles: DocumentProfileArtifactStore;
}) {
  return async (request: {
    sourceFileName: string;
    sourceLogicalPath: string;
    objectId: string;
    checksumSha256: string;
    byteCount: number;
    contentType: string;
    maximumSourceBytes: number;
    profileContractSha256: string;
    signal: AbortSignal;
  }) => {
    assertRequest(request);
    const source = await readCurrentSource(input.bodyStore, request);
    let analyzed: ReturnType<typeof analyzeDocumentSourceMarkdown>;
    try {
      analyzed = analyzeDocumentSourceMarkdown({
        fileName: request.sourceFileName,
        content: source
      });
    } catch (error) {
      throw preparationError(errorCode(error, "source_frontmatter_invalid"));
    }
    if (!analyzed.body.trim()) throw preparationError("source_body_empty");
    const contentProfile = buildSourceContentProfile({
      title: analyzed.resolvedMetadata.title,
      body: analyzed.body,
      metadata: analyzed.parsedMetadata,
      suggestions: null,
      tokenizer: input.tokenizer
    });
    const structureProfile = buildDocumentStructureProfile(analyzed.body);
    const referenceProfile = buildDocumentReferenceProfile(
      analyzed.body,
      request.sourceLogicalPath
    );
    const artifacts = {
      contentProfile: await writeProfile(input.profiles, {
        artifactKind: "content_profile",
        contractSha256: request.profileContractSha256,
        payload: {
          schemaVersion: "document-content-profile-v1",
          metadata: analyzed.metadata,
          profile: contentProfile
        },
        signal: request.signal
      }),
      structureProfile: await writeProfile(input.profiles, {
        artifactKind: "structure_profile",
        contractSha256: request.profileContractSha256,
        payload: structureProfile,
        signal: request.signal
      }),
      referenceProfile: await writeProfile(input.profiles, {
        artifactKind: "reference_profile",
        contractSha256: request.profileContractSha256,
        payload: referenceProfile,
        signal: request.signal
      })
    };
    return {
      body: analyzed.body,
      metadata: analyzed.metadata,
      parsedMetadata: analyzed.parsedMetadata,
      resolvedMetadata: analyzed.resolvedMetadata,
      contentProfile,
      structureProfile,
      referenceProfile,
      artifacts
    };
  };
}

export async function createDocumentReferenceProfileArtifact(input: {
  profiles: DocumentProfileArtifactStore;
  sourceBody: string;
  sourceLogicalPath: string;
  profileContractSha256: string;
  signal: AbortSignal;
}) {
  const referenceProfile = buildDocumentReferenceProfile(
    input.sourceBody,
    input.sourceLogicalPath
  );
  const artifact = await writeProfile(input.profiles, {
    artifactKind: "reference_profile",
    contractSha256: input.profileContractSha256,
    payload: referenceProfile,
    signal: input.signal
  });
  return { referenceProfile, artifact };
}

async function readCurrentSource(
  bodyStore: DocumentSourceBodyReadPort,
  request: {
    objectId: string;
    checksumSha256: string;
    byteCount: number;
    contentType: string;
    maximumSourceBytes: number;
    signal: AbortSignal;
  }
): Promise<string> {
  const stream = await bodyStore.readVerifiedStream({
    objectId: request.objectId,
    checksum: request.checksumSha256,
    byteCount: request.byteCount,
    contentType: request.contentType,
    maxBytes: request.maximumSourceBytes,
    signal: request.signal
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const hash = createHash("sha256");
  const parts: string[] = [];
  let byteCount = 0;
  for await (const chunk of stream) {
    throwIfAborted(request.signal);
    if (!(chunk instanceof Uint8Array)) {
      throw preparationError("source_stream_invalid");
    }
    byteCount += chunk.byteLength;
    if (byteCount > request.maximumSourceBytes || byteCount > request.byteCount) {
      throw preparationError("source_size_limit");
    }
    hash.update(chunk);
    try {
      parts.push(decoder.decode(chunk, { stream: true }));
    } catch {
      throw preparationError("source_utf8_invalid");
    }
  }
  try {
    parts.push(decoder.decode());
  } catch {
    throw preparationError("source_utf8_invalid");
  }
  if (byteCount !== request.byteCount
    || hash.digest("hex") !== request.checksumSha256) {
    throw preparationError("source_checksum_mismatch");
  }
  return parts.join("");
}

async function writeProfile(
  store: DocumentProfileArtifactStore,
  input: {
    artifactKind: "content_profile" | "structure_profile" | "reference_profile";
    contractSha256: string;
    payload: unknown;
    signal: AbortSignal;
  }
): Promise<DocumentProfileArtifactReference> {
  throwIfAborted(input.signal);
  const bytes = new TextEncoder().encode(canonicalJson(input.payload));
  if (bytes.byteLength > MAXIMUM_PROFILE_BYTES) {
    throw preparationError("profile_size_limit");
  }
  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  const stored = await store.putVerifiedJson({
    artifactKind: input.artifactKind,
    contractSha256: input.contractSha256,
    checksumSha256,
    byteCount: bytes.byteLength,
    bytes,
    signal: input.signal
  });
  if (stored.checksumSha256 !== checksumSha256
    || stored.byteCount !== bytes.byteLength || !stored.objectId) {
    throw preparationError("profile_verification_failed");
  }
  return stored;
}

function assertRequest(input: {
  sourceFileName: string;
  sourceLogicalPath: string;
  checksumSha256: string;
  byteCount: number;
  maximumSourceBytes: number;
  profileContractSha256: string;
}): void {
  if (!input.sourceFileName || !input.sourceLogicalPath
    || !/^[0-9a-f]{64}$/u.test(input.checksumSha256)
    || !/^[0-9a-f]{64}$/u.test(input.profileContractSha256)
    || !Number.isSafeInteger(input.byteCount) || input.byteCount < 0
    || !Number.isSafeInteger(input.maximumSourceBytes)
    || input.maximumSourceBytes < 1 || input.byteCount > input.maximumSourceBytes) {
    throw preparationError("invalid_source_contract");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw preparationError("profile_value_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw preparationError("profile_value_invalid");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? preparationError("cancelled");
}

function errorCode(error: unknown, fallback: string): string {
  const value = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  return typeof value === "string" && /^[a-z0-9_]{1,128}$/u.test(value)
    ? value
    : fallback;
}

function preparationError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document source preparation error: ${code}`), { code });
}
