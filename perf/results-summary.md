# Analytics performance report

Generated 2026-11-23T09:55:30.831Z by `pnpm perf:results` against the local Docker database.

- Survey: "Large survey (50k responses)": 50,000 responses (43,960 completed)
- 20 measured requests per scenario (after 2 warm-up requests), in-process HTTP (no network)
- Machine: win32 x64, Node v24.19.0

| Scenario | Source | p50 | p95 | max | Target (p95) | Result |
|---|---|---|---|---|---|---|
| Unfiltered summary | aggregate | 59 ms | 72 ms | 74 ms | < 1000 ms | PASS |
| Date-filtered summary (last 14 days) | live | 193 ms | 214 ms | 225 ms | < 5000 ms | PASS |
| Filtered incl. partial responses | live | 316 ms | 336 ms | 415 ms | < 5000 ms | PASS |
