# Analytics performance report

Generated 2026-11-23T10:58:57.825Z by `pnpm perf:results` against the local Docker database.

- Survey: "Large survey (50k responses)": 50,000 responses (43,924 completed)
- 20 measured requests per scenario (after 2 warm-up requests), in-process HTTP (no network)
- Machine: win32 x64, Node v24.19.0

| Scenario | Source | p50 | p95 | max | Target (p95) | Result |
|---|---|---|---|---|---|---|
| Unfiltered summary | aggregate | 56 ms | 59 ms | 62 ms | < 1000 ms | PASS |
| Date-filtered summary (last 14 days) | live | 181 ms | 190 ms | 192 ms | < 5000 ms | PASS |
| Filtered incl. partial responses | live | 294 ms | 301 ms | 331 ms | < 5000 ms | PASS |
