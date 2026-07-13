---
type: technical-guide
title: Container Deployment Guide
description: Container health, persistence, and rollback checks for the Atlas service.
tags: [containers, deployment, operations]
sourceUrl: https://developers.example.org/deployment/containers
platform: Linux
---

# Container Deployment Guide

Run the application and its worker as separate services. Persist database and object-storage data outside the application container.

## Health checks

The liveness check confirms that the process can serve requests. The readiness check confirms that required dependencies are available.

## Rollback

Keep the previous image digest until the deployment observation window closes. Follow the [Change Management Procedure](../../operations/change-management.md) when rollback criteria are met.
