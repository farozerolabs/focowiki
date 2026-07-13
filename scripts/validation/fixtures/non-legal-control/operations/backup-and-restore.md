---
type: operating-procedure
title: Backup and Restore Procedure
description: Backup verification, restore testing, and recovery ownership.
tags: [backup, restore, recovery]
sourceUrl: https://handbook.example.org/operations/backup-restore
reviewCycle: monthly
---

# Backup and Restore Procedure

Create encrypted database backups every day and retain the latest verified recovery point in a separate failure domain.

## Verification

Restore a backup into an isolated environment each month. Compare record counts, checksums, and application health before marking the recovery point as verified.

Record restoration failures through the [Incident Response Runbook](on-call/incident-response.md).
