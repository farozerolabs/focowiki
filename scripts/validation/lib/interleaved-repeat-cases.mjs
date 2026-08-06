export const REPEATED_CONFLICT_CASES = Object.freeze([
  { id: "upload-session-idempotent-replay", family: "upload" },
  { id: "upload-session-idempotency-payload-conflict", family: "upload" },
  { id: "concurrent-distinct-upload-same-path", family: "upload" },
  { id: "sequential-existing-upload", family: "upload" },
  { id: "changed-content-existing-path", family: "upload" },
  { id: "replace-idempotent-replay", family: "modification" },
  { id: "concurrent-replace-current-revision", family: "modification" },
  { id: "replace-stale-revision", family: "modification" },
  { id: "file-move-idempotent-replay", family: "modification" },
  { id: "file-move-competing-destination", family: "modification" },
  { id: "directory-move-idempotent-replay", family: "modification" },
  { id: "knowledge-base-update-concurrent-revision", family: "modification" },
  { id: "maintenance-idempotent-replay", family: "maintenance" },
  { id: "maintenance-concurrent-distinct-requests", family: "maintenance" },
  { id: "maintenance-replay-after-terminal", family: "maintenance" },
  { id: "file-delete-idempotent-replay", family: "deletion" },
  { id: "file-delete-after-terminal", family: "deletion" },
  { id: "directory-delete-idempotent-replay", family: "deletion" },
  { id: "directory-delete-after-terminal", family: "deletion" },
  { id: "task-delete-idempotent-overlap", family: "deletion" },
  { id: "task-delete-after-terminal", family: "deletion" },
  { id: "knowledge-base-delete-idempotent-replay", family: "deletion" }
]);

export function assertRepeatedConflictCoverage(executedCaseIds) {
  const executed = new Set(executedCaseIds);
  const expected = new Set(REPEATED_CONFLICT_CASES.map((entry) => entry.id));
  const missing = [...expected].filter((id) => !executed.has(id));
  const unexpected = [...executed].filter((id) => !expected.has(id));

  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Repeated-conflict coverage mismatch: missing=${missing.join(",") || "none"}; `
      + `unexpected=${unexpected.join(",") || "none"}.`
    );
  }
}
