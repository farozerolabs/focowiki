---
type: technical-guide
title: Service Monitoring Guide
description: Metrics and alerts for request handling, workers, and persistence services.
tags: [monitoring, metrics, operations]
sourceUrl: https://developers.example.org/deployment/monitoring
platform: Linux
---

# Service Monitoring Guide

Monitor request rate, error rate, latency percentiles, queue age, worker throughput, database connections, and memory usage.

Alerts should identify customer impact and the affected service. Avoid alerts that fire from a single transient sample.

When an alert represents active impact, continue with the [Incident Response Runbook](../../operations/on-call/incident-response.md).
