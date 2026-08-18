import { posix } from "node:path";
import {
  normalizePortableDirectoryPath,
  normalizePortablePagePath,
  normalizePortableTerm,
  portableByFileGraphPath,
  portableIndexDirectoryPath
} from "@focowiki/okf";
import { classifyDocumentNavigationTerm } from "./document-term-routing.js";

type JsonRecord = Record<string, unknown>;
type ReadJson = (logicalPath: string) => Promise<JsonRecord>;

export function createDocumentPortableAgentTraversal(input: {
  readJson: ReadJson;
  maximumReads?: number;
}) {
  const maximumReads = input.maximumReads ?? 16;
  if (!Number.isSafeInteger(maximumReads) || maximumReads < 1 || maximumReads > 1_024) {
    throw traversalError("read_limit_invalid");
  }

  async function session<TResult>(
    run: (read: ReadJson) => Promise<TResult>
  ): Promise<{ result: TResult; reads: readonly string[] }> {
    const reads: string[] = [];
    const read: ReadJson = async (logicalPath) => {
      if (reads.length >= maximumReads) throw traversalError("read_limit_exceeded");
      reads.push(logicalPath);
      return input.readJson(logicalPath);
    };
    return { result: await run(read), reads };
  }

  return {
    exactPath(path: string) {
      return session(async (read) => {
        const pagePath = normalizePortablePagePath(path);
        const router = await read(
          portableIndexDirectoryPath(posix.dirname(pagePath)) + "/index.json"
        );
        const resource = resourceForKey(router, pagePath);
        const packet = await read(resource);
        return arrayRecords(packet.documents).find((item) =>
          item.path === pagePath) ?? null;
      });
    },
    term(value: string) {
      return session(async (read) => {
        const term = normalizePortableTerm(value);
        const bucket = classifyDocumentNavigationTerm(term);
        const catalog = await read("_index/terms/index.json");
        const bucketRoute = arrayRecords(catalog.buckets).find((route) =>
          route.bucket === bucket);
        if (!bucketRoute) throw traversalError("term_bucket_missing");
        const router = await read(asString(bucketRoute.path));
        const routes = arrayRecords(router.routes).filter((route) =>
          compareText(asString(route.firstTerm), term) <= 0
          && compareText(term, asString(route.lastTerm)) <= 0);
        const postings: JsonRecord[] = [];
        for (const route of routes) {
          const packet = await read(asString(route.path));
          const entry = arrayRecords(packet.terms).find((item) => item.term === term);
          if (entry) postings.push(...arrayRecords(entry.postings));
        }
        return postings.sort((left, right) =>
          compareText(asString(left.path), asString(right.path)));
      });
    },
    directory(scopePath: string) {
      return session(async (read) => {
        const scope = normalizePortableDirectoryPath(scopePath);
        return read(portableIndexDirectoryPath(scope) + "/index.json");
      });
    },
    relationships(path: string) {
      return session(async (read) => {
        const pagePath = normalizePortablePagePath(path);
        const value = await read(portableByFileGraphPath(pagePath));
        if (value.path !== pagePath) throw traversalError("graph_source_mismatch");
        return arrayRecords(value.relationships);
      });
    }
  };
}

function resourceForKey(router: JsonRecord, key: string): string {
  const resource = arrayRecords(router.resources).find((item) =>
    compareText(asString(item.firstKey), key) <= 0
      && compareText(key, asString(item.lastKey)) <= 0);
  if (!resource) throw traversalError("document_route_missing");
  return asString(resource.path);
}

function arrayRecords(value: unknown): JsonRecord[] {
  if (!Array.isArray(value) || value.some((item) =>
    typeof item !== "object" || item === null || Array.isArray(item))) {
    throw traversalError("resource_invalid");
  }
  return value as JsonRecord[];
}

function asString(value: unknown): string {
  if (typeof value !== "string" || !value) throw traversalError("resource_invalid");
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function traversalError(code: string): Error & { code: string } {
  return Object.assign(new Error("Portable Agent traversal error: " + code), { code });
}
