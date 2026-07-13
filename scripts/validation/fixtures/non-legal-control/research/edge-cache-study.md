---
type: research-note
title: Edge Cache Latency Study
description: Measurements comparing regional cache hit and miss latency.
tags:
  - research
  - caching
  - latency
sourceUrl: https://research.example.org/studies/edge-cache-latency
sampleSize: 12000
---

# Edge Cache Latency Study

The study measured twelve thousand requests across four regions. Cache hits reduced median response time from 184 milliseconds to 42 milliseconds.

Cache misses remained sensitive to origin connection setup. The largest variation appeared during short traffic bursts rather than sustained load.

## Limitations

The experiment used one content size and did not measure invalidation delay. A follow-up study should vary payload size and update frequency.
