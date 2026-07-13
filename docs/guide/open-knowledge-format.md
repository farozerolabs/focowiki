---
title: Open Knowledge Format
---

# Open Knowledge Format

Focowiki generates a Markdown knowledge base aligned with the Google Open Knowledge Format (OKF) v0.1 Draft. The format keeps knowledge portable and readable through Markdown files, YAML frontmatter, standard links, directory indexes, and update logs.

## Official Baseline

Focowiki pins one retrieved specification revision so upstream edits cannot silently change validation behavior.

- [Google Cloud announcement](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/)
- [OKF v0.1 Draft, pinned revision `ee67a5ca`](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/ee67a5ca27044ebe7c38385f5b6cffc2305a9c1a/okf/SPEC.md)

The implementation distinguishes official rules from Focowiki producer rules.

| Classification | Behavior |
| --- | --- |
| Official required | Concept frontmatter is parseable, concept `type` is non-empty, and reserved `index.md` and `log.md` files use their defined structures. |
| Official recommended | Concepts use helpful titles, descriptions, resources, tags, timestamps, structured Markdown, links, index descriptions, and numbered citations when evidence exists. |
| Focowiki producer | Generated links resolve, labels agree with target concepts, navigation remains complete, and large directories use bounded continuation concepts. |

Missing optional metadata and unknown safe metadata do not invalidate a concept. Focowiki preserves safe producer-defined fields and does not impose a domain taxonomy.

## Concept Files

Every non-reserved Markdown concept uses UTF-8 Markdown and YAML frontmatter with a non-empty `type`.

```md
---
type: "Guide"
title: "Incident response"
description: "Steps for responding to a production incident."
resource: "https://docs.example.com/incident-response"
tags:
  - operations
  - reliability
timestamp: "2026-07-13T00:00:00Z"
owner: "Platform team"
---

# Incident response

Start by confirming the affected service and current impact.
```

`title`, `description`, `resource`, `tags`, and `timestamp` are recommended when the source provides reliable evidence. Fields such as `owner` remain available as producer metadata.

## Reserved Files

The exact filenames `index.md` and `log.md` are reserved.

The root `index.md` may declare only `okf_version: "0.1"` in frontmatter. Nested `index.md` files contain no frontmatter. Both use headings and standard Markdown links.

```md
---
okf_version: "0.1"
---
# Product knowledge

Generated at: 2026-07-13T00:00:00.000Z

## Explore

- [Browse documents](/pages/index.md) - Explore source-backed Markdown files by directory.
- [Metadata and navigation schema](/schema.md) - Review concept metadata and navigation conventions.
- [Update history](/log.md) - Review bounded publication history.
- [Machine-readable indexes](/_index/index.md) - Access generated manifests, search records, links, and changes.
```

A nested directory index keeps the same direct form without frontmatter:

```md
# Runbooks

- [Incident response](/pages/runbooks/incident-response.md) - Steps for responding to a production incident.
```

The root `log.md` contains no frontmatter. It starts with `# Directory Update Log`, groups entries under ISO dates, and orders newer groups first.

```md
# Directory Update Log

## 2026-07-13

* **Publication**: Published 12 Markdown pages.

## 2026-07-12

* **Publication**: Published 10 Markdown pages.
```

## Links And Citations

Focowiki-generated internal links use bundle-relative paths beginning with `/`. A generated relationship must resolve to a source-backed Markdown file or to a typed navigation concept that leads to source-backed evidence.

Generated citations use one trailing section with consecutive numbers:

```md
# Citations

[1] [Source](https://docs.example.com/incident-response)
[2] [Service handbook](/pages/handbooks/service.md)
```

Focowiki preserves source-authored links and source-authored citation sections without restyling or renumbering them.

## Generated Structure

```text
index.md
log.md
log-000001.md
schema.md
schema-frontmatter.md
schema-navigation.md
schema-extensions.md
pages/
  index.md
  runbooks/
    index.md
    incident-response.md
  large-directory/
    index.md
    index-000001.md
    index-map-000001.md
_index/
  index.md
  manifest.json
  search.json
  links.json
  changes.json
_graph/
  index.md
  manifest.json
  ...
```

Source-backed concepts under `pages/` remain the final reading and citation evidence. `schema*.md`, `log-*.md`, directory continuation pages, `_index/`, and `_graph/` are Focowiki producer extensions.

Generated Markdown extensions outside exact `index.md` and `log.md` use normal concept frontmatter and a descriptive `type`, such as `Schema Reference`, `Directory Index Page`, `Directory Index Map`, or `Update History Page`. Exact `_index/index.md` and `_graph/index.md` remain reserved nested indexes and contain no frontmatter.

## Large Directories And Histories

An exact directory `index.md` remains bounded. When a direct listing exceeds the configured entry or byte budget, it links to typed `index-000001.md` continuation concepts. Each continuation exposes directory, previous, and next navigation and lists a deterministic range of direct entries.

If the continuation catalog also exceeds the budget, the exact index links to typed `index-map-000001.md` concepts. Focowiki does not create artificial domain folders or omit source concepts. Each source-backed concept appears exactly once in its directory navigation sequence.

The root `log.md` retains a bounded recent window. Older retained entries move to typed `log-000001.md` concepts with root, previous, and next navigation.

## Publication Validation

A generated release becomes readable after concept, reserved-file, generated-link, continuation-chain, and source-navigation checks pass. Validation returns bounded rule IDs and logical paths when generated output is invalid.

Optional metadata, unknown types, unknown safe fields, missing optional user indexes, and source-authored broken links remain readable. Focowiki applies the zero-broken-link rule only to links generated by Focowiki.

Admin preview and Developer OpenAPI expose the same logical paths and generated Markdown content. Generated files do not contain Admin URLs, storage paths, queue state, credentials, or internal identifiers used only by the service.

## Scale Profile

Directory navigation and release validation use bounded pages, continuation concepts, and release-scoped durable facts. A large knowledge base does not require one corpus-wide Markdown index or loading all source bodies into one process.

The validation suite covers flat and nested 100,000-concept structures. It verifies bounded Markdown files, complete navigation, deterministic link coverage, and stable resource use.
