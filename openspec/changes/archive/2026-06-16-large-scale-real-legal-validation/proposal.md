## Why

The current real legal Markdown validation covers the core single and batch upload flows, but the default sample size is still too small to expose scale-related regressions in pagination, Redis coordination, S3-backed file reads, OpenAPI paths, security checks, and task progress behavior. Before release, the product needs a repeatable large-scale validation pass using real cleaned legal Markdown data so product bugs can be found, fixed, and covered by regression checks.

## What Changes

- Add a large-scale real legal Markdown validation profile that uploads at least 50 `.md` files in one batch using a local-only dataset path supplied at runtime.
- Extend black-box validation to cover Admin UI, Admin API, public OpenAPI, upload, task, file tree, preview, deletion, republish, knowledge base deletion, auth, path-safety, and stable error behavior.
- Extend white-box validation to inspect PostgreSQL, Redis, S3-compatible storage, OKF bundle generation, JSON indexes, source mapping, task lifecycle, pagination, and audit evidence through bounded checks.
- Add security validation for upload rejection, session/auth behavior, protected Admin UI routes, OpenAPI key behavior, traversal, unsupported methods, raw source hiding, CORS/security headers, rate limits where available, and redaction.
- Add performance validation focused on bounded memory/CPU behavior, database pagination, Redis cursor/cache/lock usage, S3 streaming boundaries, request latency budgets, task duration evidence, and absence of unbounded process-memory catalogs.
- Require discovered bugs to be fixed in the owning module with focused regression tests or validation checks, then rerun the affected slice and final large-scale flow.
- Keep all local dataset paths, raw legal bodies, credentials, API keys, S3 object keys, model provider payloads, and private machine details out of committed code, tests, reports, and OpenSpec artifacts.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `cleaned-legal-e2e-validation`: extend the existing real legal full-flow validation from bounded 24-file coverage to large-scale 50+ file coverage with full black-box, white-box, security, performance, and bug-fix requirements.
- `cleaned-markdown-upload-validation`: extend cleaned Markdown sample selection and upload validation so large batches are selected from local-only configuration, uploaded safely, verified through all product surfaces, and reported without local data leakage.

## Impact

- Affected validation scripts: `scripts/validation/*`, browser validation scripts, sample selection, reporting, and redaction utilities.
- Affected test suites: API integration tests, OKF generation tests, Admin UI/browser tests, security validation tests, performance/boundedness checks, and regression tests for bugs found during validation.
- Affected product areas when bugs are found: Admin UI, Admin API, public OpenAPI, upload processor, task lifecycle, PostgreSQL repositories, Redis coordination, S3 storage adapter, OKF bundle generation, pagination, and security middleware.
- Runtime dependencies remain the existing local PostgreSQL, Redis, external S3-compatible storage, Admin API, Admin UI, public OpenAPI, and optional model configuration. No real local dataset path or file body may be committed.
