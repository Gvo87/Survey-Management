# Analytics performance report

Generated 2026-11-23T12:06:23.319Z by `pnpm perf:results` against the local Docker database.

- Survey: "Large survey (50k responses)": 50,000 responses (43,931 completed)
- 20 measured requests per scenario (after 2 warm-up requests), in-process HTTP (no network)
- Machine: win32 x64, Node v24.19.0

| Scenario | Source | p50 | p95 | max | Target (p95) | Result |
|---|---|---|---|---|---|---|
| Unfiltered summary | aggregate | 57 ms | 59 ms | 59 ms | < 1000 ms | PASS |
| Date-filtered summary (last 14 days) | live | 187 ms | 201 ms | 215 ms | < 5000 ms | PASS |
| Filtered incl. partial responses | live | 300 ms | 308 ms | 315 ms | < 5000 ms | PASS |
| Answer filter (NPS 0-6 AND plan) | live | 351 ms | 394 ms | 401 ms | < 5000 ms | PASS |
| 4 segments side by side (by plan) | aggregate | 834 ms | 875 ms | 930 ms | < 5000 ms | PASS |
| XLSX export of 43,931 responses (5.2 MB) | worker | 8.3 s | - | - | < 120 s | PASS |
