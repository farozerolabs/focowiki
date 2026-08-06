import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

type Revision = {
  publicId: string;
  checksum: string;
  document: {
    schemaVersion: "storage-vnext-settings-v1";
    version: number;
    source: "bootstrap" | "admin";
    sections: Record<string, unknown>;
  };
};

type CreateRevision = (input: {
  current: Revision["document"] | null;
  key: string;
  value: unknown;
  source: "bootstrap" | "admin";
}) => Revision;
type ReadRevision = (input: {
  publicId: string;
  checksum: string;
  document: unknown;
}) => Revision;

let createRevision: CreateRevision | undefined;
let readRevision: ReadRevision | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/runtime-settings/revision-document.ts"
  );
  const loaded = await import(
    /* @vite-ignore */ pathToFileURL(modulePath).href
  ).catch(() => ({})) as Record<string, unknown>;
  createRevision = loaded.createStorageVnextRuntimeSettingsRevision as
    CreateRevision | undefined;
  readRevision = loaded.readStorageVnextRuntimeSettingsRevision as
    ReadRevision | undefined;
});

describe("storage vNext immutable runtime settings revisions", () => {
  it("uses only the vNext revision, current pointer, and security audit tables", () => {
    const repository = readFileSync(resolve(
      import.meta.dirname,
      "../src/runtime-settings/repository.ts"
    ), "utf8");
    const service = readFileSync(resolve(
      import.meta.dirname,
      "../src/runtime-settings/service.ts"
    ), "utf8");

    expect(repository).toContain("focowiki.runtime_setting_revisions");
    expect(repository).toContain("focowiki.runtime_setting_current");
    expect(repository).toContain("focowiki.security_audit_events");
    expect(repository).not.toMatch(/focowiki\.runtime_settings(?!_)/u);
    expect(repository).not.toContain("runtime_setting_audit_logs");
    expect(service).toContain("getCurrentRevision");
  });

  it("creates one deterministic immutable first revision", () => {
    expect(createRevision).toBeTypeOf("function");
    if (!createRevision) return;
    const worker = { sourceFileConcurrency: 2 };
    const first = createRevision({
      current: null,
      key: "worker",
      value: worker,
      source: "bootstrap"
    });
    worker.sourceFileConcurrency = 9;
    const replay = createRevision({
      current: null,
      key: "worker",
      value: { sourceFileConcurrency: 2 },
      source: "bootstrap"
    });

    expect(first).toEqual(replay);
    expect(first.publicId).toMatch(/^runtime-settings-[0-9a-f]{64}$/u);
    expect(first.checksum).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.document).toEqual({
      schemaVersion: "storage-vnext-settings-v1",
      version: 1,
      source: "bootstrap",
      sections: { worker: { sourceFileConcurrency: 2 } }
    });
  });

  it("carries every existing section into the next complete revision", () => {
    expect(createRevision).toBeTypeOf("function");
    if (!createRevision) return;
    const first = createRevision({
      current: null,
      key: "worker",
      value: { sourceFileConcurrency: 2 },
      source: "bootstrap"
    });
    const second = createRevision({
      current: first.document,
      key: "search",
      value: { maxInFlightTasks: 4 },
      source: "admin"
    });

    expect(second.document.version).toBe(2);
    expect(second.document.source).toBe("admin");
    expect(second.document.sections).toEqual({
      worker: { sourceFileConcurrency: 2 },
      search: { maxInFlightTasks: 4 }
    });
    expect(second.publicId).not.toBe(first.publicId);
  });

  it("round-trips a verified revision and rejects checksum or identity tampering", () => {
    expect(createRevision).toBeTypeOf("function");
    expect(readRevision).toBeTypeOf("function");
    if (!createRevision || !readRevision) return;
    const create = createRevision;
    const read = readRevision;
    const revision = create({
      current: null,
      key: "search",
      value: { maxInFlightTasks: 4 },
      source: "admin"
    });

    expect(read(revision)).toEqual(revision);
    expect(() => read({
      ...revision,
      checksum: "0".repeat(64)
    })).toThrowError(expect.objectContaining({ code: "revision_conflict" }));
    expect(() => read({
      ...revision,
      publicId: `runtime-settings-${"1".repeat(64)}`
    })).toThrowError(expect.objectContaining({ code: "revision_conflict" }));
  });

  it("rejects malformed, unsafe, and oversized revision values", () => {
    expect(createRevision).toBeTypeOf("function");
    if (!createRevision) return;
    const create = createRevision;
    for (const value of [undefined, Number.NaN, ["invalid"]]) {
      expect(() => create({
        current: null,
        key: "worker",
        value,
        source: "admin"
      })).toThrowError(expect.objectContaining({ code: "invalid_revision" }));
    }
    expect(() => create({
      current: null,
      key: "worker",
      value: { payload: "x".repeat(65_536) },
      source: "admin"
    })).toThrowError(expect.objectContaining({ code: "revision_too_large" }));
  });
});
