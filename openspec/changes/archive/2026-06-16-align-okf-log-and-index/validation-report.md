# Real Legal Full-Flow Validation Report

- Change: align-okf-log-and-index
- Kind: api
- Started at: 2026-06-16T08:48:01.069Z
- Finished at: 2026-06-16T08:51:56.520Z
- Source: <FOCOWIKI_VALIDATION_MARKDOWN_DIR>
- Result: pass

## Sample Coverage

- Samples: 24
- Single-upload sample: “景德镇制”陶瓷保护条例__2024-04-03__有效__e5dad75ccd4a.md
- Batch-upload samples: 23
- Statuses: 尚未生效, 已修改, 有效
- Types: 司法解释, 地方性法规, 法律, 监察法规, 行政法规
- Unknown date sample: yes
- Long title sample: yes
- Duplicated title sample: yes
- Non-ASCII basename sample: yes
- Unknown metadata sample: yes
- Scanned candidate profiles: 3303
- Coverage warnings: none

## Model Assistance

- Enabled: yes
- Model: mimo-v2.5
- Context window tokens: 1000000
- Suggestion concurrency: 2

## Validation Passes

- Pass 1: bounded sample selection and redacted prerequisite validation.
- Pass 2: real service API, public OpenAPI, persistence, storage, Redis, OKF, model-mode, and deletion validation.
- Pass 3: Admin UI browser validation plus final repository verification and report leak scan.

## Commands Run

- pnpm validate:real-legal:samples
- pnpm validate:real-legal:api
- pnpm validate:real-legal:browser
- pnpm verify
- pnpm build
- pnpm test:validation
- pnpm validate:no-local-paths
- openspec validate validate-real-legal-full-flow

## Tests Run

- bounded sample selection
- report redaction
- Admin API black-box flow
- public OpenAPI black-box flow
- PostgreSQL, Redis, S3, and OKF white-box checks
- Admin UI browser flow
- repository no-local-path scan
- lint, typecheck, unit tests, and build

## Manual Review Items

- Review optional sample coverage warnings to decide whether the configured local dataset should be broadened.
- Review the Vite chunk size warning separately if frontend bundle size becomes a release concern.

## Single Upload File

- “景德镇制”陶瓷保护条例__2024-04-03__有效__e5dad75ccd4a.md: type=地方性法规, status=有效, date=2024-04-03

## Batch Upload Files

- 七台河市人民代表大会及其常务委员会立法条例__2017-10-18__已修改__f47e5f396b87.md: type=地方性法规, status=已修改, date=2017-10-18
- 中华人民共和国民族团结进步促进法__2026-03-12__尚未生效__a4e5f6619030.md: type=法律, status=尚未生效, date=2026-03-12
- 中华人民共和国专利法__2008-12-27__已修改__532cc56dd979.md: type=法律, status=已修改, date=2008-12-27
- 上海航运交易所管理规定__1996-10-03__有效__445687b4a325.md: type=行政法规, status=有效, date=1996-10-03
- “泉州：宋元中国的世界海洋商贸中心”世界遗产保护管理条例__2023-11-30__有效__6285667a0bd1.md: type=地方性法规, status=有效, date=2023-11-30
- 人民检察院公益诉讼办案规则__2021-06-29__有效__4a2b368e3f2e.md: type=司法解释, status=有效, date=2021-06-29
- 中华人民共和国监察法实施条例__2021-09-20__已修改__2ee288056a68.md: type=监察法规, status=已修改, date=2021-09-20
- 三明市人民代表大会及其常务委员会立法条例__unknown-date__已修改__a08bd104aebc.md: type=地方性法规, status=已修改, date=unknown-date
- 最高人民检察院关于贪污养老、医疗等社会保险基金能否适用《最高人民法院 最高人民检察院关于办理贪污贿赂刑事案件适用法律若干问题的解释》第一条第二款第一项规定的批复__2017-07-26__有效__00915d.md: type=司法解释, status=有效, date=2017-07-26
- “漳州110”发展促进条例__2025-06-04__有效__c4abd66db907.md: type=地方性法规, status=有效, date=2025-06-04
- （已记录）本溪满族自治县河道管理条例__2021-06-30__有效__faf770f2df98.md: type=地方性法规, status=有效, date=2021-06-30
- 七台河市人民代表大会及其常务委员会立法条例__2024-10-31__有效__d9603e69c448.md: type=地方性法规, status=有效, date=2024-10-31
- 七台河市倭肯河流域水环境保护条例__2021-12-24__有效__903b385819f0.md: type=地方性法规, status=有效, date=2021-12-24
- （已记录）蚌埠市电梯安全管理条例__2021-01-04__有效__c5ff91d1e480.md: type=地方性法规, status=有效, date=2021-01-04
- 《湖南省实施-中华人民共和国种子法-办法》__2019-09-28__有效__479c150a8d6b.md: type=地方性法规, status=有效, date=2019-09-28
- 《湖南省水上交通安全条例（通过稿）》__2017-11-30__有效__30f85d360844.md: type=地方性法规, status=有效, date=2017-11-30
- 七台河市东北抗联文化遗存保护利用条例__2019-06-28__有效__f156de31f9f0.md: type=地方性法规, status=有效, date=2019-06-28
- 七台河市倭肯河流域水环境保护条例__2021-12-24__有效__a3108863d8b9.md: type=地方性法规, status=有效, date=2021-12-24
- 七台河市医疗废物管理若干规定__2020-06-18__有效__cfd76d360131.md: type=地方性法规, status=有效, date=2020-06-18
- 七台河市城市公园条例__2018-07-02__有效__d12652a3da95.md: type=地方性法规, status=有效, date=2018-07-02
- 七台河市城市绿化条例__2023-06-28__有效__cf0d4c2dfa51.md: type=地方性法规, status=有效, date=2023-06-28
- 七台河市建筑垃圾管理条例__2025-07-31__有效__91aa12a21e54.md: type=地方性法规, status=有效, date=2025-07-31
- 七台河市文明祭祀条例__2022-11-03__有效__ac53f1abb010.md: type=地方性法规, status=有效, date=2022-11-03

## Selected Files

- “景德镇制”陶瓷保护条例__2024-04-03__有效__e5dad75ccd4a.md: type=地方性法规, status=有效, date=2024-04-03
- 七台河市人民代表大会及其常务委员会立法条例__2017-10-18__已修改__f47e5f396b87.md: type=地方性法规, status=已修改, date=2017-10-18
- 中华人民共和国民族团结进步促进法__2026-03-12__尚未生效__a4e5f6619030.md: type=法律, status=尚未生效, date=2026-03-12
- 中华人民共和国专利法__2008-12-27__已修改__532cc56dd979.md: type=法律, status=已修改, date=2008-12-27
- 上海航运交易所管理规定__1996-10-03__有效__445687b4a325.md: type=行政法规, status=有效, date=1996-10-03
- “泉州：宋元中国的世界海洋商贸中心”世界遗产保护管理条例__2023-11-30__有效__6285667a0bd1.md: type=地方性法规, status=有效, date=2023-11-30
- 人民检察院公益诉讼办案规则__2021-06-29__有效__4a2b368e3f2e.md: type=司法解释, status=有效, date=2021-06-29
- 中华人民共和国监察法实施条例__2021-09-20__已修改__2ee288056a68.md: type=监察法规, status=已修改, date=2021-09-20
- 三明市人民代表大会及其常务委员会立法条例__unknown-date__已修改__a08bd104aebc.md: type=地方性法规, status=已修改, date=unknown-date
- 最高人民检察院关于贪污养老、医疗等社会保险基金能否适用《最高人民法院 最高人民检察院关于办理贪污贿赂刑事案件适用法律若干问题的解释》第一条第二款第一项规定的批复__2017-07-26__有效__00915d.md: type=司法解释, status=有效, date=2017-07-26
- “漳州110”发展促进条例__2025-06-04__有效__c4abd66db907.md: type=地方性法规, status=有效, date=2025-06-04
- （已记录）本溪满族自治县河道管理条例__2021-06-30__有效__faf770f2df98.md: type=地方性法规, status=有效, date=2021-06-30
- 七台河市人民代表大会及其常务委员会立法条例__2024-10-31__有效__d9603e69c448.md: type=地方性法规, status=有效, date=2024-10-31
- 七台河市倭肯河流域水环境保护条例__2021-12-24__有效__903b385819f0.md: type=地方性法规, status=有效, date=2021-12-24
- （已记录）蚌埠市电梯安全管理条例__2021-01-04__有效__c5ff91d1e480.md: type=地方性法规, status=有效, date=2021-01-04
- 《湖南省实施-中华人民共和国种子法-办法》__2019-09-28__有效__479c150a8d6b.md: type=地方性法规, status=有效, date=2019-09-28
- 《湖南省水上交通安全条例（通过稿）》__2017-11-30__有效__30f85d360844.md: type=地方性法规, status=有效, date=2017-11-30
- 七台河市东北抗联文化遗存保护利用条例__2019-06-28__有效__f156de31f9f0.md: type=地方性法规, status=有效, date=2019-06-28
- 七台河市倭肯河流域水环境保护条例__2021-12-24__有效__a3108863d8b9.md: type=地方性法规, status=有效, date=2021-12-24
- 七台河市医疗废物管理若干规定__2020-06-18__有效__cfd76d360131.md: type=地方性法规, status=有效, date=2020-06-18
- 七台河市城市公园条例__2018-07-02__有效__d12652a3da95.md: type=地方性法规, status=有效, date=2018-07-02
- 七台河市城市绿化条例__2023-06-28__有效__cf0d4c2dfa51.md: type=地方性法规, status=有效, date=2023-06-28
- 七台河市建筑垃圾管理条例__2025-07-31__有效__91aa12a21e54.md: type=地方性法规, status=有效, date=2025-07-31
- 七台河市文明祭祀条例__2022-11-03__有效__ac53f1abb010.md: type=地方性法规, status=有效, date=2022-11-03

## Checks

- PASS [white-box] postgres-prerequisite: PostgreSQL is reachable.
- PASS [white-box] redis-prerequisite: Redis is reachable.
- PASS [white-box] s3-prerequisite: S3-compatible storage accepts put and get operations.
- PASS [white-box] model-assistance-mode: Model assistance is enabled with bounded context, timeout, and concurrency settings.
- PASS [black-box] admin-auth-required: Admin API rejects unauthenticated knowledge base reads.
- PASS [black-box] public-openapi-prerequisite: Public OpenAPI is reachable.
- PASS [black-box] http-security-headers: Admin API and public OpenAPI return security response headers on validation responses.
- PASS [black-box] admin-login: Admin login succeeded with configured credentials.
- PASS [black-box] public-openapi-managed-key: Loaded one-time managed OpenAPI key from Admin API.
- PASS [black-box] knowledge-base-create: Created validation knowledge base.
- PASS [black-box] single-upload-submit: Uploaded one selected sample in a single-file upload action.
- PASS [black-box] single-task-ended: Single-file upload task reached ended lifecycle state.
- PASS [black-box] single-task-detail: Single-file task detail exposes bounded admin-only phase entries.
- PASS [black-box] single-upload-task-row: Single-file upload is represented as one task row with one lifecycle status.
- PASS [black-box] single-admin-file-surfaces: Admin release, bundle, tree, detail, and public URL surfaces work after single upload.
- PASS [white-box] okf-public-artifacts: Public OKF Markdown, metadata indexes, headings, and graph links are internally consistent.
- PASS [black-box] single-public-openapi: Public scoped Markdown, JSON, task, auth, source hiding, and error checks passed after single upload.
- PASS [white-box] single-database-boundaries: PostgreSQL contains durable records, original file names, storage-backed keys, and no raw file body columns after single upload.
- PASS [white-box] single-s3-object-boundaries: S3 contains internal source objects and generated public page objects without exposing source logical paths after single upload.
- PASS [black-box] batch-upload-submit: Uploaded selected batch samples in one upload action.
- PASS [black-box] batch-task-ended: Batch upload task reached ended lifecycle state.
- PASS [black-box] batch-task-detail: Batch task detail exposes bounded admin-only phase entries.
- PASS [black-box] single-batch-upload-task-rows: Single and batch upload actions are represented as two task rows with one lifecycle status each.
- PASS [black-box] task-source-pagination: Task source files are paginated with an independent bounded cursor.
- PASS [black-box] batch-admin-file-surfaces: Admin release, bundle, tree, detail, and public URL surfaces include single and batch generated files.
- PASS [white-box] okf-public-artifacts: Public OKF Markdown, metadata indexes, headings, and graph links are internally consistent.
- PASS [black-box] batch-public-openapi: Public scoped Markdown, JSON, task, auth, source hiding, and error checks passed after batch upload.
- PASS [white-box] batch-database-boundaries: PostgreSQL contains durable records, original file names, storage-backed keys, and no raw file body columns after batch upload.
- PASS [white-box] batch-s3-object-boundaries: S3 contains internal source objects and generated public page objects without exposing source logical paths after batch upload.
- PASS [white-box] redis-boundaries: Redis scan did not find selected sample Markdown bodies in string values.
- PASS [black-box] source-page-delete-submit: Submitted source-backed page deletion through the Admin API.
- PASS [black-box] task-ended: Upload task reached ended lifecycle state.
- PASS [black-box] task-detail: Task detail exposes bounded admin-only phase entries.
- PASS [white-box] deletion-database-boundaries: PostgreSQL records source deletion, one ended deletion task, task phases, and a replacement active release.
- PASS [black-box] public-deletion-state: Public OpenAPI and generated indexes reflect source-backed page deletion.
- PASS [black-box] source-page-delete-full-flow: Source-backed page deletion republished active files without stale page references.
- PASS [black-box] knowledge-base-delete: Knowledge base deletion hides admin and public reads.
- PASS [white-box] security-audit-evidence: Security audit records were written for the validation run without secret-like values.

## White-box Checks

- PASS postgres-prerequisite: PostgreSQL is reachable.
- PASS redis-prerequisite: Redis is reachable.
- PASS s3-prerequisite: S3-compatible storage accepts put and get operations.
- PASS model-assistance-mode: Model assistance is enabled with bounded context, timeout, and concurrency settings.
- PASS okf-public-artifacts: Public OKF Markdown, metadata indexes, headings, and graph links are internally consistent.
- PASS single-database-boundaries: PostgreSQL contains durable records, original file names, storage-backed keys, and no raw file body columns after single upload.
- PASS single-s3-object-boundaries: S3 contains internal source objects and generated public page objects without exposing source logical paths after single upload.
- PASS okf-public-artifacts: Public OKF Markdown, metadata indexes, headings, and graph links are internally consistent.
- PASS batch-database-boundaries: PostgreSQL contains durable records, original file names, storage-backed keys, and no raw file body columns after batch upload.
- PASS batch-s3-object-boundaries: S3 contains internal source objects and generated public page objects without exposing source logical paths after batch upload.
- PASS redis-boundaries: Redis scan did not find selected sample Markdown bodies in string values.
- PASS deletion-database-boundaries: PostgreSQL records source deletion, one ended deletion task, task phases, and a replacement active release.
- PASS security-audit-evidence: Security audit records were written for the validation run without secret-like values.

## Black-box Checks

- PASS admin-auth-required: Admin API rejects unauthenticated knowledge base reads.
- PASS public-openapi-prerequisite: Public OpenAPI is reachable.
- PASS http-security-headers: Admin API and public OpenAPI return security response headers on validation responses.
- PASS admin-login: Admin login succeeded with configured credentials.
- PASS public-openapi-managed-key: Loaded one-time managed OpenAPI key from Admin API.
- PASS knowledge-base-create: Created validation knowledge base.
- PASS single-upload-submit: Uploaded one selected sample in a single-file upload action.
- PASS single-task-ended: Single-file upload task reached ended lifecycle state.
- PASS single-task-detail: Single-file task detail exposes bounded admin-only phase entries.
- PASS single-upload-task-row: Single-file upload is represented as one task row with one lifecycle status.
- PASS single-admin-file-surfaces: Admin release, bundle, tree, detail, and public URL surfaces work after single upload.
- PASS single-public-openapi: Public scoped Markdown, JSON, task, auth, source hiding, and error checks passed after single upload.
- PASS batch-upload-submit: Uploaded selected batch samples in one upload action.
- PASS batch-task-ended: Batch upload task reached ended lifecycle state.
- PASS batch-task-detail: Batch task detail exposes bounded admin-only phase entries.
- PASS single-batch-upload-task-rows: Single and batch upload actions are represented as two task rows with one lifecycle status each.
- PASS task-source-pagination: Task source files are paginated with an independent bounded cursor.
- PASS batch-admin-file-surfaces: Admin release, bundle, tree, detail, and public URL surfaces include single and batch generated files.
- PASS batch-public-openapi: Public scoped Markdown, JSON, task, auth, source hiding, and error checks passed after batch upload.
- PASS source-page-delete-submit: Submitted source-backed page deletion through the Admin API.
- PASS task-ended: Upload task reached ended lifecycle state.
- PASS task-detail: Task detail exposes bounded admin-only phase entries.
- PASS public-deletion-state: Public OpenAPI and generated indexes reflect source-backed page deletion.
- PASS source-page-delete-full-flow: Source-backed page deletion republished active files without stale page references.
- PASS knowledge-base-delete: Knowledge base deletion hides admin and public reads.

## Bug Fixes

- None recorded.

## Failures

- None recorded.
