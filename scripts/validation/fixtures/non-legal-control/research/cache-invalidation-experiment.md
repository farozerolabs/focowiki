---
type: research-note
title: Cache Invalidation Experiment
description: Results from comparing event-driven and time-based cache invalidation.
tags: [research, caching, consistency]
sourceUrl: https://research.example.org/studies/cache-invalidation
experimentId: cache-2026-04
---

# Cache Invalidation Experiment

Event-driven invalidation reduced stale reads during frequent updates. Time-based expiration produced fewer coordination messages during read-heavy periods.

The experiment found that a short expiration remained useful as a recovery mechanism when an invalidation event was delayed. The next experiment will measure behavior during regional network loss.

Latency observations should be compared with the [Edge Cache Latency Study](edge-cache-study.md).
