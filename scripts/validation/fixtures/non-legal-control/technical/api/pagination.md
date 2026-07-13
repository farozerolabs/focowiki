---
type: technical-guide
title: Cursor Pagination
description: Stable cursor pagination rules for collection endpoints.
tags: [api, pagination, cursor]
sourceUrl: https://developers.example.org/api/pagination
language: en
---

# Cursor Pagination

Collection endpoints return an opaque `nextCursor` when another page is available. Clients send the cursor back to the same endpoint with the same filters.

A cursor cannot be reused with a different filter set. Clients should restart pagination after changing sort order, scope, or filtering criteria.

Authentication requirements are documented in [Service API Authentication](authentication.md).
