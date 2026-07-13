---
type: technical-guide
title: Service API Authentication
description: Token handling and request requirements for service integrations.
tags:
  - api
  - authentication
sourceUrl: https://developers.example.org/api/authentication
language: en
---

# Service API Authentication

Clients send a scoped access token in the `Authorization` header. Tokens must stay outside source control and application logs.

## Request requirements

Use TLS for every request. Retry temporary failures with bounded exponential backoff. Generate a new idempotency key for each distinct write operation.

## Rotation

Create the replacement token before revoking the previous token. Verify one request with the replacement token, then remove the previous credential.
