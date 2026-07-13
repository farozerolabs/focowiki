---
type: runbook
title: Incident Response Runbook
description: Triage and communication steps for customer-facing service incidents.
tags: [incident, on-call, recovery]
sourceUrl: https://handbook.example.org/operations/incident-response
severityLevels:
  - critical
  - high
  - moderate
---

# Incident Response Runbook

The incident commander confirms customer impact, assigns an investigator, and opens a shared timeline.

## Triage

Check recent deployments, dependency health, error rate, latency, and queue depth. Preserve evidence before restarting a service.

## Communication

Publish an initial status update within fifteen minutes for critical incidents. Continue updates at the interval recorded in the incident channel.

Any emergency change still requires the rollback checks in [Change Management](../change-management.md).
