import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createStorageVnextOwnerMarkerDocument,
  serializeStorageVnextOwnerMarker
} from "../src/storage-vnext/bootstrap/owner-marker.js";
import { createStorageVnextFilesystemPlane } from "../src/storage-vnext/bootstrap/filesystem-plane.js";
import { createStorageVnextOwnedScopeProof } from "../src/storage-vnext/bootstrap/owned-scope.js";

const runId = "svnext-20260801T173500Z-b1c2d3e4f5a6";
const proof = createStorageVnextOwnedScopeProof({
  runId,
  nonceHash: "d".repeat(64),
  createdAt: "2026-08-01T09:35:00.000Z",
  filesystemScope: join(tmpdir(), runId)
});

describe("storage vNext owned filesystem reset planes", () => {
  let parentDirectory = "";
  let runRoot = "";

  beforeEach(async () => {
    parentDirectory = await mkdtemp(join(tmpdir(), "focowiki-svnext-fs-test-"));
    runRoot = join(parentDirectory, runId);
    const localProof = { ...proof, filesystemScope: runRoot };
    const recreatedProof = createStorageVnextOwnedScopeProof({
      runId: localProof.runId,
      nonceHash: localProof.nonceHash,
      createdAt: localProof.createdAt,
      filesystemScope: localProof.filesystemScope
    });
    Object.assign(proof, recreatedProof);

    await mkdir(join(runRoot, "runtime-secrets"), { recursive: true, mode: 0o700 });
    await mkdir(join(runRoot, "tmp"), { recursive: true, mode: 0o700 });
    await mkdir(join(runRoot, "logs"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(runRoot, ".focowiki-run-owner.json"),
      serializeStorageVnextOwnerMarker(
        createStorageVnextOwnerMarkerDocument(proof, proof.filesystemScope)
      ),
      { mode: 0o600 }
    );
    await writeFile(join(runRoot, "runtime-secrets", "deployment.key"), "run-secret\n");
    await writeFile(join(runRoot, "tmp", "partial.bin"), "partial\n");
    await writeFile(join(runRoot, "logs", "api.log"), "keep\n");
  });

  afterEach(async () => {
    await rm(parentDirectory, { recursive: true, force: true });
  });

  it.each(["runtime-secrets", "temporary-files"] as const)(
    "clears only the exact %s child and preserves the run marker and siblings",
    async (planeName) => {
      const plane = createStorageVnextFilesystemPlane(planeName);
      const inspection = await plane.inspect(proof);

      expect(inspection).toMatchObject({
        plane: planeName,
        exists: true,
        createdByRun: true,
        existedBeforeRun: false,
        broadTarget: false,
        ownerMarker: proof.ownerMarker,
        bootstrapState: "incompatible"
      });

      await plane.reset(proof);

      expect(await plane.verifyReset(proof)).toBe(true);
      expect(await readdir(join(runRoot, planeName === "temporary-files" ? "tmp" : planeName)))
        .toEqual([]);
      expect(await readFile(join(runRoot, "logs", "api.log"), "utf8")).toBe("keep\n");
      expect(await readFile(join(runRoot, ".focowiki-run-owner.json"), "utf8"))
        .toContain(proof.ownerMarker);
    }
  );

  it("recreates only a missing exact child during bootstrap", async () => {
    await rm(join(runRoot, "tmp"), { recursive: true });
    const plane = createStorageVnextFilesystemPlane("temporary-files");

    expect((await plane.inspect(proof)).bootstrapState).toBe("empty");
    await plane.bootstrap(proof);

    expect(await plane.verifyBootstrap(proof)).toBe(true);
    expect((await lstat(join(runRoot, "tmp"))).isDirectory()).toBe(true);
  });

  it("refuses a symlinked child without deleting its external target", async () => {
    const outside = join(parentDirectory, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "keep\n");
    await rm(join(runRoot, "tmp"), { recursive: true });
    await symlink(outside, join(runRoot, "tmp"));
    const plane = createStorageVnextFilesystemPlane("temporary-files");

    await expect(plane.reset(proof)).rejects.toThrow(/owned filesystem scope/u);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("refuses a mismatched marker before deleting runtime secrets", async () => {
    await writeFile(join(runRoot, ".focowiki-run-owner.json"), "{}\n");
    const plane = createStorageVnextFilesystemPlane("runtime-secrets");

    await expect(plane.reset(proof)).rejects.toThrow(/owned filesystem scope/u);
    expect(await readFile(join(runRoot, "runtime-secrets", "deployment.key"), "utf8"))
      .toBe("run-secret\n");
  });
});
