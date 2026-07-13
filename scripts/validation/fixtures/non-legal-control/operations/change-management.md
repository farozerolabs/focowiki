---
type: operating-procedure
title: Change Management Procedure
description: Review, approval, deployment, and rollback requirements for production changes.
tags:
  - operations
  - deployment
  - rollback
sourceUrl: https://handbook.example.org/operations/change-management
reviewCycle: quarterly
---

# Change Management Procedure

Every production change requires an owner, a reviewer, a deployment window, and a rollback condition.

## Before deployment

- Record the expected customer impact.
- Confirm monitoring and rollback commands.
- Assign an incident contact for the deployment window.

## After deployment

Observe error rate, latency, and resource usage for thirty minutes. Start rollback when a documented threshold is crossed.

For active incidents, use the [Incident Response Runbook](on-call/incident-response.md).
