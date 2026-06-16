## Context

Focowiki already has real cleaned legal Markdown validation for single-file and 24-file batch flows. That coverage has proven the main Admin API, Admin UI, public OpenAPI, S3-backed bundle, PostgreSQL records, Redis coordination, and OKF generation path, but it is still too small to reliably expose scaling issues in pagination, task progress, file tree growth, generated indexes, security middleware, and performance boundaries.

This change adds a large-scale validation profile that uses real cleaned legal Markdown from local-only runtime configuration. The implementation must keep product code and repository artifacts clean: no committed local dataset path, no raw legal body, no credentials, no raw S3 object key, no provider payload, and no private machine detail. The validation must continue the project's lightweight, modular direction: use PostgreSQL, Redis, and S3-compatible storage as the source of truth and avoid unbounded process-memory work.

## Goals / Non-Goals

**Goals:**

- Validate at least 50 real cleaned legal Markdown files in one batch upload action.
- Exercise full product behavior across Admin UI, Admin API, backend repositories, Redis coordination, S3 storage, OKF bundle generation, public OpenAPI, deletion, republish, and knowledge base deletion.
- Add black-box tests for user-visible and public HTTP behavior.
- Add white-box tests for bounded persistence, storage, task, index, and security internals.
- Add performance checks that detect unbounded full-tree/full-corpus processing, slow responses, missing pagination, Redis misuse, and process-memory pressure.
- Add security checks for auth, session, CSRF/origin, path safety, unsupported methods, upload rejection, rate limits where configured, CORS/security headers, redacted errors, and audit evidence.
- Fix bugs found during validation with focused modular changes and regression coverage.
- Produce a final redacted report that records evidence without leaking local paths, raw bodies, credentials, object keys, or provider details.

**Non-Goals:**

- Do not commit the real legal Markdown dataset or any local absolute dataset path.
- Do not introduce a law-specific product mode; the platform remains a generic Markdown knowledge base.
- Do not redesign Admin UI workflows unless validation exposes a real usability or functional bug.
- Do not add a graph database or heavyweight performance test framework unless existing scripts and Node/browser tooling cannot provide the required evidence.
- Do not weaken existing single-file or 24-file validation coverage.

## Decisions

1. Use a separate large-scale validation profile instead of replacing the existing 24-file profile.

   The existing smaller flow is useful for quick regression checks. A separate profile can require 50+ files, longer timeouts, performance metrics, and broader security probes without making every local validation run expensive.

2. Select real files through local-only runtime configuration.

   The implementation should read the dataset directory from an environment variable such as `FOCOWIKI_VALIDATION_MARKDOWN_DIR`, plus a minimum count such as `FOCOWIKI_VALIDATION_MIN_BATCH_FILES=50`. Reports may include basenames and counts, but not local roots or raw bodies.

3. Keep validation bounded and persistence-first.

   Sample selection should inspect directory entries and frontmatter metadata with bounded reads. Upload, task polling, file tree checks, public reads, and white-box database checks should use paginated or directly scoped calls. PostgreSQL remains the durable source of truth, Redis remains coordination/cache/cursor state, and S3-compatible storage remains the file-body store.

4. Make black-box and white-box checks separate modules.

   Keep API client checks, browser checks, public OpenAPI checks, persistence checks, Redis checks, S3 checks, security checks, performance checks, report writing, and redaction as focused modules or functions. Avoid growing one validation script into a single hard-to-maintain file.

5. Use performance budgets as validation inputs, not hardcoded assumptions.

   Large-scale validation should record task duration, selected file count, generated file count, endpoint response times, pagination page counts, Redis key scan summaries, and process memory snapshots where practical. Default budgets can fail on clear regressions, while thresholds remain configurable for smaller local machines and larger servers.

6. Treat discovered bugs as part of the change.

   When validation exposes a product bug, capture the failing step first, add a focused failing test or validation assertion when practical, fix the owning module, rerun the affected slice, then rerun the final large-scale flow. Keep fixes minimal and modular.

## Risks / Trade-offs

- [Risk] Large-scale validation may take several minutes when model assistance is enabled. → Mitigation: use explicit task timeouts, idle timeout handling, progress reporting, and configurable model/upload concurrency.
- [Risk] Running against a developer's existing local database can collide with older schema or existing data. → Mitigation: support a disposable validation database or clear prerequisite error, and document how to run migrations before the flow.
- [Risk] Performance measurements vary by machine. → Mitigation: record metrics and enforce only conservative budgets by default; allow local threshold overrides.
- [Risk] Reports can accidentally leak local paths or secrets. → Mitigation: reuse redaction utilities, run repository leak checks, and fail validation if reports contain local roots, credentials, object keys, or raw body snippets.
- [Risk] Browser tests can be flaky under long-running batch uploads. → Mitigation: poll durable task state through UI-visible changes and use bounded waits tied to configured task timeout rather than arbitrary sleeps.
- [Risk] Security probes can mutate state or pollute audit logs. → Mitigation: run them against a dedicated validation knowledge base and assert audit records are bounded and redacted.

## Migration Plan

No production data migration is planned for the proposal itself. Implementation may add validation scripts, tests, report artifacts, and small product bug fixes discovered by the flow. If a bug fix requires schema changes, it must include a migration and targeted migration verification.

Roll back by reverting the validation script/test changes and any bug-fix commits. Local validation databases or generated S3 objects must be created under test-scoped knowledge base IDs and cleaned up by the flow when possible.

## Open Questions

- Should the large-scale profile default to exactly 50 files or allow a larger configured count while enforcing a minimum of 50?
  - Recommended answer: enforce a minimum of 50 and allow larger configured counts.
- Should model assistance be required for the large-scale validation run?
  - Recommended answer: run with the current configured model mode; record whether model assistance was enabled, but do not require it for deterministic validation.
- Should performance budgets be hard failures in all environments?
  - Recommended answer: fail only on clear boundedness violations by default; make latency and duration thresholds configurable so local laptops and servers can use different budgets.
