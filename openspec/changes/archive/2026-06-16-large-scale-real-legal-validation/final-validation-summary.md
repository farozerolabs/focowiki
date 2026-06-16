# Large-Scale Validation Summary

- Change: `large-scale-real-legal-validation`
- Result: pass
- Sample profile: `large-scale`
- Selected samples: `51`
- Batch-upload samples: `50`
- API checks: `42`
- Browser checks: `17`
- Failures: `0`

## Commands

- `pnpm validate:real-legal:large:samples`
- `pnpm validate:real-legal:large:api`
- `pnpm validate:real-legal:large:browser`
- `pnpm test:validation`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test`
- `pnpm verify`
- `pnpm validate:no-local-paths`
- `openspec validate large-scale-real-legal-validation --strict`

## API Evidence

- Validated Admin API login, invalid login rejection, origin rejection, upload rejection, knowledge base creation, single upload, 50-file batch upload, task rows, task source pagination, file tree, file detail, releases, bundle files, public URLs, source-backed deletion, republish, knowledge base deletion, and expected errors.
- Validated public OpenAPI auth, invalid key rejection, scoped Markdown/JSON reads, `index.md`, `log.md`, `schema.md`, representative `pages/*.md`, `_index/manifest.json`, `_index/search.json`, `_index/links.json`, latest task status, unsupported methods, traversal rejection, raw source hiding, deletion state, stable errors, and admin route isolation on the public listener.
- Validated PostgreSQL records, original filenames, metadata JSON, absence of raw body columns, Redis body leak scan, S3 source and generated object reads, generated OKF artifacts, JSON index consistency, graph links, audit events, and redaction.
- Performance evidence recorded endpoint timing, task duration, pagination evidence, and process memory delta.

## Browser Evidence

- Validated Admin UI login, language switching, knowledge base creation/opening, single upload, 50-file batch upload, submitted dialog closure, live task observation, expanded nested task file table, task source pagination, file tree refresh, preview, public URL copy, source-backed file deletion, and knowledge base deletion.

## Bugs

- No product bug was found during the final large-scale run.

## Remaining Risk

- The Vite production build still emits the existing chunk-size warning. Build succeeds.
