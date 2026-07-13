---
title: File Cleaning and Ingestion Guide
---

# File Cleaning and Ingestion Guide

Focowiki uploads Markdown files. Teams that start from PDF, Word, HTML, spreadsheets, OCR text, exports, or mixed folders should clean those materials before upload and produce stable `.md` files.

This guide describes the target file shape and the cleaning workflow. It applies to professional corpora such as manuals, policies, research records, contracts, regulations, support playbooks, product documents, and internal knowledge bases.

## Target Output

Each cleaned document should become one UTF-8 Markdown file when the document is meant to be read as a complete unit. Large source packages can be split when they contain multiple independent documents, but the split should preserve the source title, source identifier, and section boundaries.

The target file has three parts:

| Part | Purpose |
| --- | --- |
| YAML frontmatter | Stores stable metadata for display, filtering, search, source tracking, and Agent context. |
| Markdown body | Stores the full readable document with headings, paragraphs, tables, lists, citations, and links. |
| Source notes | Stores source evidence, conversion notes, unresolved issues, and update history when useful. |

Focowiki parses safe frontmatter fields, preserves domain metadata, reads headings and links, and generates an OKF-style bundle with `index.md`, `schema.md`, `_index/`, `pages/`, and `_graph/` files.

## Folder Paths And Generated Paths

The Admin upload dialog accepts loose Markdown files or one selected folder with nested subfolders. Folder upload keeps each NFC-normalized relative path. A source such as `handbook/onboarding/guide.md` is published as `pages/handbook/onboarding/guide.md`; loose files use their basename below `pages/`.

Selecting the same folder again adds paths that are absent from the knowledge base. Existing active paths are skipped and keep their source IDs and revisions. Content changes for an existing path use the explicit source-file replacement operation.

Every selected item must be a `.md` file. Keep path segments stable and avoid absolute paths, `.` or `..` segments, backslashes, control characters, and case-only path duplicates. Focowiki reserves generated navigation basenames matching `index.md`, `index-<number>.md`, `index-map-<number>.md`, `log.md`, and `log-<number>.md`. Rename source files that use these basenames before upload.

Focowiki creates directory `index.md` files and numbered index or index-map pages when a direct listing exceeds its configured budgets. These generated navigation pages link to the next page and remain available through the tree and content APIs. Agents use them to discover source-backed Markdown pages and read those pages as evidence.

## Cleaning Workflow

Use the same workflow for every source format. The tools can differ by format, but the output contract stays the same.

| Step | Work |
| --- | --- |
| Inventory | List source files, source systems, file owners, publication dates, update dates, identifiers, languages, and known duplicates. |
| Extract | Get text, tables, headings, links, captions, footnotes, and source URLs from the original material. |
| Normalize | Repair encoding, heading levels, paragraph breaks, table layout, citation style, and repeated headers or footers. |
| Map metadata | Convert source metadata into safe YAML frontmatter. Keep domain fields when they are useful for readers and Agents. |
| Render Markdown | Write one stable `.md` file per document or per intentional document split. |
| Validate | Check frontmatter, links, duplicate titles, source evidence, unsafe fields, file size, and readability. |
| Sample review | Review representative documents before uploading large batches. |
| Upload | Upload cleaned Markdown through the Admin UI or Developer OpenAPI and inspect generated outputs. |

## Markdown Structure

A cleaned Markdown file should start with YAML frontmatter.

```md
---
type: "policy"
title: "Customer Data Handling Policy"
description: "Rules for handling customer data in support and operations workflows."
tags:
  - data-governance
  - support
sourceUrl: "https://example.com/policies/customer-data"
sourceName: "Company Policy Portal"
publishedAt: "2026-03-01"
updatedAt: "2026-05-15"
version: "2026.05"
language: "en"
externalId: "policy-customer-data"
sourceHash: "sha256:example"
---

# Customer Data Handling Policy

## Scope

This policy applies to support, operations, and account management teams.

## Handling Rules

| Case | Required Action |
| --- | --- |
| Customer account question | Verify the requester identity before sharing account details. |
| Export request | Follow the approved export workflow and record the request. |

## Related Materials

- [Support escalation policy](./support-escalation.md)
```

Use one clear document title. Keep heading levels stable. Preserve tables as Markdown tables when the table is readable. Preserve source links as Markdown links. Move footnotes and appendices into ordinary Markdown sections when the original layout cannot be represented safely.

## Metadata Guidance

Common metadata fields:

These fields are recommended examples for interoperable Markdown files. Uploads can also include domain-specific metadata. Focowiki preserves safe and valid frontmatter fields and passes them through to generated outputs.

| Field | Use |
| --- | --- |
| `type` | Document kind, such as `policy`, `manual`, `contract`, `research-note`, or `page`. |
| `title` | Original or canonical document title. |
| `description` | Short human-written or reviewed summary. |
| `tags` | Compact tags for topics, teams, products, regions, or workflows. |
| `sourceUrl` | Canonical web page, document system URL, or public reference URL. |
| `sourceName` | Name of the system, publisher, repository, or dataset. |
| `publishedAt` | Original publication date when available. |
| `updatedAt` | Last source update date when available. |
| `version` | Source version, release number, edition, or status marker. |
| `language` | Main document language. |
| `externalId` | Stable ID from the source system. |
| `sourceHash` | Hash of the cleaned source or original extraction input. |

Examples of domain metadata include but are not limited to `owner`, `department`, `region`, `product`, `category`, `status`, `jurisdiction`, `standard`, `reviewCycle`, or `sourceSystem`.

Remove fields that expose secrets, local filesystem paths, private object storage paths, temporary conversion folders, provider payloads, raw credentials, internal queue IDs, or one-time processing run IDs.

## Cleaning Skill Example

Developers can place a small Skill in their own Agent environment to standardize repeated corpus cleaning work. The Skill should keep the scope narrow: read source files, produce Markdown, enrich metadata from evidence, and write a short review report.

Example `SKILL.md`:

```md
---
name: clean-focowiki-markdown
description: Use when a user asks to clean source documents into Focowiki-ready Markdown, normalize frontmatter, supplement metadata from document evidence, or prepare files for upload to a file-first knowledge base.
---

# Clean Focowiki Markdown

## Reference

Read the Focowiki file cleaning guide before cleaning when network access is available:
https://docs.focowiki.com/guide/file-cleaning-ingestion

## Workflow

1. Inspect the input folder and identify source formats, duplicate files, document titles, source evidence, and unsafe fields.
2. Preserve the original files. Write cleaned Markdown files to a separate output folder.
3. Produce one `.md` file for each readable document. Split only when a source package contains multiple independent documents.
4. Add YAML frontmatter with verified metadata. Use source evidence, document headings, and body content before adding fields.
5. Keep domain-specific metadata when it is safe and useful. Remove secrets, local paths, private storage paths, temporary run IDs, provider payloads, and credentials.
6. Preserve the complete readable body with stable headings, tables, lists, citations, and links.
7. Validate YAML, filenames, duplicate titles, encoding, links, OCR risk areas, and large files.
8. Write a short report with processed counts, skipped files, uncertain metadata, manual review items, and upload readiness.

## Metadata Rules

- `title`: use the source title or first reliable heading.
- `description`: write one neutral sentence from the document body.
- `tags`: use 3 to 8 compact topic tags supported by the content.
- `sourceUrl`, `sourceName`, `publishedAt`, `updatedAt`, `version`, `externalId`, and `sourceHash`: fill only when evidence exists.
- Domain fields: preserve safe fields such as `owner`, `region`, `status`, `category`, `jurisdiction`, `product`, or `sourceSystem`.
- Unknown fields: omit the field or leave an empty value according to the user's project convention.

## Output

Return:

- Cleaned Markdown output folder
- Validation summary
- Manual review list
- Upload recommendation
```

## Source Format Guidance

| Source format | Cleaning guidance |
| --- | --- |
| Word and rich text | Keep headings, lists, tables, footnotes, comments that matter, and tracked-change decisions. Remove visual-only styling. |
| PDF | Extract text in reading order. Rebuild headings and tables. Check page headers, page footers, hyphenated line breaks, and column ordering. |
| HTML and website exports | Keep semantic headings, body text, canonical URLs, links, tables, and publication metadata. Remove navigation, cookie banners, ads, and repeated layout blocks. |
| Spreadsheets and CSV records | Turn each independent row, sheet, or record group into Markdown when it represents a readable knowledge item. Use tables for structured values that readers compare directly. |
| Scanned documents and OCR text | Review OCR confidence, names, numbers, dates, headings, table cells, and punctuation. Mark unresolved OCR issues in source notes. |
| JSON, XML, database exports, and API exports | Map stable fields into frontmatter. Render the reader-facing content as prose, lists, or tables. Preserve original identifiers. |
| Existing Markdown folders | Normalize frontmatter, title style, relative links, heading levels, filenames, and duplicate pages. Keep meaningful Markdown links. |
| Mixed corpora | Process each source type with its own extractor, then apply one shared Markdown and metadata standard before upload. |

## Body Content Rules

The body should contain the full information needed for a reader or Agent to inspect the document without returning to the original file.

- Keep definitions, exceptions, constraints, examples, tables, and appendices.
- Preserve the order of sections when order changes meaning.
- Keep citations, references, source URLs, and related document links.
- Use ordinary Markdown links for relationships between cleaned files.
- Write unresolved conversion issues under a short `## Source Notes` section when needed.
- Keep generated summaries short when they appear in the body. The original content should remain the main body.

## Quality Checks

Run these checks before upload:

| Check | What to inspect |
| --- | --- |
| YAML | Frontmatter parses correctly and uses valid strings, arrays, dates, and booleans. |
| Title | Each file has one clear title. Duplicate titles are intentional and traceable. |
| Filenames | Filenames are stable, readable, and end with `.md`. |
| Encoding | Files use UTF-8 and preserve punctuation, names, numbers, and dates. |
| Headings | Heading levels are logical and do not skip important structure. |
| Tables | Tables remain readable and do not lose columns or row labels. |
| Links | Relative links and source links resolve or have clear notes. |
| OCR | OCR output has been reviewed for high-risk names, numbers, dates, and headings. |
| Metadata | Domain fields are useful, safe, and free from temporary processing details. |
| Size | Very large documents are reviewed for intentional split points. |
| Privacy | Secrets, local paths, private storage paths, internal URLs, and credentials are removed. |

Review a sample from each source type before uploading a large corpus. For large datasets, include normal files, long files, short files, table-heavy files, link-heavy files, and files with missing source metadata.

## Upload and Inspect

After cleaning, upload the Markdown files through the Admin UI or Developer OpenAPI.

After processing, inspect:

| Output | What to check |
| --- | --- |
| `pages/*.md` | Title, frontmatter, body, related links, and source notes. |
| `index.md` | Knowledge-base overview and page listing. |
| `schema.md` | Metadata conventions and generated file conventions. |
| `_index/search.json` | Search fields, titles, descriptions, tags, and paths. |
| `_index/links.json` | Markdown links and graph-backed related links. |
| `_graph/by-file/{fileId}.json` | Per-file relationships, reasons, weights, and related page paths. |
| `log.md` | Recent publish history and rolling update notes. |

The generated files should expose logical paths and safe metadata. They should not expose local paths, S3 object keys, conversion directories, credentials, or provider payloads.

## Practical Acceptance Criteria

A cleaned Markdown corpus is ready for upload when these statements are true:

- Every file is a valid `.md` file.
- Every document has a clear title.
- Frontmatter contains useful source and domain metadata.
- The body preserves the document's complete readable content.
- Links and references are useful for people and Agents.
- Source evidence is preserved when available.
- Unsafe internal details have been removed.
- A sample review confirms that generated `pages/`, `_index/`, and `_graph/` files are understandable.

## Related Documentation

- [Open Knowledge Format](./open-knowledge-format.md)
- [File-first Graph](./file-first-graph.md)
- [Developer OpenAPI](../openapi/index.md)
