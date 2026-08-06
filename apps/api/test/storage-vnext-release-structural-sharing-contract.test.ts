import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const ports = readFileSync(
  resolve(workspaceRoot, "apps/api/src/storage-vnext/release/ports.ts"),
  "utf8"
);
const repository = readFileSync(
  resolve(workspaceRoot, "apps/api/src/storage-vnext/release/postgres-repository.ts"),
  "utf8"
);
const publicationSnapshot = readFileSync(
  resolve(workspaceRoot, "apps/api/src/storage-vnext/publication/postgres-snapshot.ts"),
  "utf8"
);
const migration = readFileSync(
  resolve(workspaceRoot, "apps/api/migrations/001_storage_vnext.sql"),
  "utf8"
)
  .replace(/\s+/gu, " ")
  .replace(/\(\s+/gu, "(")
  .replace(/\s+\)/gu, ")")
  .toLowerCase();

describe("storage vNext release structural sharing contract", () => {
  it("reports created, reused, and newly attached shard descriptors", () => {
    expect(ports).toMatch(
      /StorageVnextShardAttachmentResult[\s\S]*createdDescriptorCount:[\s\S]*reusedDescriptorCount:[\s\S]*attachedCount:/u
    );
    expect(ports).toMatch(
      /addCandidateShards\(input:[\s\S]*Promise<StorageVnextShardAttachmentResult>/u
    );
    expect(repository).toContain("createdDescriptorCount");
    expect(repository).toContain("reusedDescriptorCount");
    expect(repository).toContain("attachedCount");
  });

  it("deduplicates one content/range identity across bounded roots", () => {
    expect(migration).toContain(
      "release_shards_scope_key primary key (knowledge_base_id, public_id)"
    );
    expect(migration).toContain(
      "release_shards_content_key unique (knowledge_base_id, logical_kind, checksum_sha256, first_logical_path, last_logical_path)"
    );
    expect(migration).toContain(
      "primary key (release_root_public_id, release_shard_public_id)"
    );
    expect(repository).not.toMatch(
      /copyForward|cloneActive|publication_generations|generation_projection_segments/u
    );
  });

  it("treats delta ordinals as local metadata instead of cross-lineage identity", () => {
    expect(migration).not.toContain("release_root_shards_order_key");
    expect(migration).not.toContain("release_catalog_entries_order_key");
    expect(migration).not.toContain("directory_summaries_order_key");
    expect(migration).toContain(
      "when shard.logical_kind = 'directory_navigation' then length(shard.first_logical_path)::text || ':' || shard.first_logical_path || ':' || attached.ordinal::text"
    );
    expect(migration).not.toContain("chr(0)");
  });

  it("represents active catalogs as bounded root lineage plus explicit path tombstones", () => {
    expect(migration).toContain("base_root_public_id text");
    expect(migration).toContain("create table focowiki.release_catalog_tombstones");
    expect(migration).toContain("create function focowiki.resolve_release_catalog");
    expect(ports).toMatch(/addCandidateCatalogTombstones\(input:/u);
    expect(repository).toContain("base_root_public_id");
    expect(repository).toContain("resolve_release_catalog");
    expect(repository).toContain("MAX_STORAGE_VNEXT_RELEASE_LINEAGE_DEPTH = 8");
    expect(repository).toContain("compactActiveReleaseLineage");
    expect(repository).not.toMatch(
      /insert into focowiki\.release_catalog_entries[\s\S]*select[\s\S]*resolve_release_catalog/u
    );
  });

  it("resolves one inherited projection path without expanding the effective catalog", () => {
    const targetedRead = publicationSnapshot.match(
      /async function findEffectiveGeneratedObject[\s\S]*?\n\}\n\nasync function readGeneratedObject/u
    )?.[0];

    expect(targetedRead).toBeDefined();
    expect(targetedRead).toContain("WITH RECURSIVE lineage");
    expect(targetedRead).toContain("CROSS JOIN LATERAL");
    expect(targetedRead).toContain("release_catalog_entries");
    expect(targetedRead).toContain("release_catalog_tombstones");
    expect(targetedRead).not.toContain("resolve_release_catalog(");
  });

  it("shadows moved directory summaries by stable identity before logical path", () => {
    expect(migration).toContain(
      "identity_effective as (select distinct on (summary.directory_public_id)"
    );
    expect(migration).toContain("from identity_effective summary");
    expect(migration).toContain(
      "directory_summaries_directory_identity_key unique (release_root_public_id, directory_public_id)"
    );
  });
});
