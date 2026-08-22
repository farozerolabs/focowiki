import { createHash } from "node:crypto";
import {
  assertDocumentProjectionDirectoryOwnership,
  assertDocumentProjectionPathOwnership,
  normalizeDocumentProjectionOwnedPath
} from "./document-projection-path-ownership.js";
import type { DocumentProjectionScopeIdentity } from
  "./document-projection-path-ownership.js";

export type DocumentPublicationOutputScope = Readonly<{
  kind: "source" | "relation" | "directory" | "graph"
    | "_index" | "_graph" | "root" | "validation";
  key: string;
}>;

export type DocumentPublicationPageAction = Readonly<{
  logicalPath: string;
  normalizedPath: string;
  action: "put" | "delete";
  entryKind: string | null;
  objectId: string | null;
  checksumSha256: string | null;
  byteCount: number | null;
}>;

export type DocumentPublicationNavigationAction = Readonly<{
  directoryPath: string;
  order: number;
  action: "upsert" | "delete";
  mutation: Readonly<Record<string, unknown>>;
}>;

export function normalizeDocumentPublicationScopeOutput(input: Readonly<{
  scope: DocumentPublicationOutputScope;
  sourceFilePublicId?: string | null;
  inputSnapshotFingerprintSha256: string;
  rendererContractVersion: string;
  pages: readonly DocumentPublicationPageAction[];
  navigationMutations: readonly DocumentPublicationNavigationAction[];
  validationEvidence: Readonly<Record<string, unknown>>;
}>) {
  if (!isSha256(input.inputSnapshotFingerprintSha256)
    || !input.rendererContractVersion
    || Buffer.byteLength(input.rendererContractVersion, "utf8") > 128
    || input.pages.length > 10_000
    || input.navigationMutations.length > 10_000) {
    throw outputError("publication_scope_output_invalid");
  }
  const ownedScope = projectionOwnedScope(input.scope);
  const pages = input.pages.map((page) => normalizePage(input, page))
    .sort((left, right) => bytewise(left.normalizedPath, right.normalizedPath));
  if (new Set(pages.map((page) => page.normalizedPath)).size !== pages.length) {
    throw outputError("publication_scope_page_duplicate");
  }
  const navigationMutations = input.navigationMutations.map((mutation) => {
    if (!Number.isSafeInteger(mutation.order) || mutation.order < 0
      || mutation.order > 999_999) {
      throw outputError("publication_navigation_order_invalid");
    }
    if (!ownedScope) {
      throw outputError("publication_validation_scope_has_output");
    }
    assertDocumentProjectionDirectoryOwnership({
      scope: ownedScope,
      directoryPath: mutation.directoryPath
    });
    return {
      ...mutation,
      directoryPath: mutation.directoryPath.toLocaleLowerCase("en-US")
    };
  }).sort((left, right) => bytewise(left.directoryPath, right.directoryPath)
    || left.order - right.order);
  const navigationKeys = navigationMutations.map((mutation) =>
    `${mutation.directoryPath}\0${mutation.order}`);
  if (new Set(navigationKeys).size !== navigationKeys.length) {
    throw outputError("publication_navigation_duplicate");
  }
  const normalized = {
    pages,
    navigationMutations,
    validationEvidence: canonicalize(input.validationEvidence) as Readonly<
      Record<string, unknown>
    >
  };
  return {
    ...normalized,
    outputFingerprintSha256: createHash("sha256").update(canonicalJson({
      inputSnapshotFingerprintSha256: input.inputSnapshotFingerprintSha256,
      rendererContractVersion: input.rendererContractVersion,
      ...normalized
    })).digest("hex")
  };
}

export function selectDocumentPublicationObjectWrites(input: Readonly<{
  desired: readonly Readonly<{
    normalizedPath: string;
    checksumSha256: string;
    objectFormat: string;
  }>[];
  existing: readonly Readonly<{
    objectId: string;
    checksumSha256: string;
    objectFormat: string;
    state: string;
  }>[];
}>) {
  const verifiedByContent = new Map(input.existing.flatMap((item) =>
    item.state === "verified" ? [[
      `${item.checksumSha256}\0${item.objectFormat}`,
      item.objectId
    ]] : []));
  const reused: { normalizedPath: string; objectId: string }[] = [];
  const writes: typeof input.desired[number][] = [];
  for (const desired of [...input.desired].sort((left, right) =>
    bytewise(left.normalizedPath, right.normalizedPath))) {
    const objectId = verifiedByContent.get(
      `${desired.checksumSha256}\0${desired.objectFormat}`
    );
    if (objectId) reused.push({ normalizedPath: desired.normalizedPath, objectId });
    else writes.push(desired);
  }
  return { reused, writes };
}

export function selectDocumentPublicationRemovedPaths(input: Readonly<{
  basePages: readonly Pick<DocumentPublicationPageAction,
    "normalizedPath" | "action">[];
  renderedPaths: readonly string[];
  explicitRemovedPaths: readonly string[];
  deleteOmittedBasePages: boolean;
}>): readonly string[] {
  const rendered = new Set(input.renderedPaths);
  return [...new Set([
    ...input.explicitRemovedPaths,
    ...(input.deleteOmittedBasePages
      ? input.basePages.flatMap((page) => page.action === "put"
        && !rendered.has(page.normalizedPath) ? [page.normalizedPath] : [])
      : [])
  ])].sort(bytewise);
}

function normalizePage(
  input: Readonly<{
    scope: DocumentPublicationOutputScope;
    sourceFilePublicId?: string | null;
  }>,
  page: DocumentPublicationPageAction
): DocumentPublicationPageAction {
  const normalizedPath = normalizeDocumentProjectionOwnedPath(
    page.normalizedPath
  );
  if (page.logicalPath.toLocaleLowerCase("en-US") !== normalizedPath) {
    throw outputError("publication_page_path_mismatch");
  }
  const ownedScope = projectionOwnedScope(input.scope);
  if (!ownedScope) {
    throw outputError("publication_validation_scope_has_output");
  }
  assertDocumentProjectionPathOwnership({
    scope: ownedScope,
    logicalPath: page.logicalPath,
    sourceFilePublicId: input.sourceFilePublicId ?? null
  });
  if (page.action === "delete") {
    if (page.entryKind !== null || page.objectId !== null
      || page.checksumSha256 !== null || page.byteCount !== null) {
      throw outputError("publication_delete_payload_invalid");
    }
  } else if (!page.entryKind || !page.objectId
    || !isSha256(page.checksumSha256)
    || !Number.isSafeInteger(page.byteCount) || page.byteCount! < 0) {
    throw outputError("publication_put_payload_invalid");
  }
  return { ...page, normalizedPath };
}

function canonicalize(value: unknown): unknown {
  return JSON.parse(canonicalJson(value)) as unknown;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => bytewise(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function projectionOwnedScope(
  scope: DocumentPublicationOutputScope
): DocumentProjectionScopeIdentity | null {
  if (scope.kind === "validation") return null;
  return { kind: scope.kind, key: scope.key };
}

function bytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function outputError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document publication output error: ${code}`), {
    code
  });
}
