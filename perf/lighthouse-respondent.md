# Respondent page performance (Lighthouse)

Generated 2026-11-23T09:41:02.104Z by `pnpm --filter @survey/e2e lighthouse`.

- Page: a published 15-question survey (2 pages), production build served by `vite preview`, API on localhost
- Profile: Lighthouse mobile defaults: simulated throttling (150 ms RTT, 1.6 Mbps down, 4x CPU slowdown)
- 3 runs, median shown

| Metric | Median | Budget | Result |
|---|---|---|---|
| Largest Contentful Paint | 1508 ms | < 2000 ms | PASS |
| First Contentful Paint | 1358 ms | - | - |
| Total Blocking Time | 0 ms | - | - |
| Performance score | 100 | - | - |

Note: the API runs on the same machine, so server latency is near zero; simulated throttling still applies
network round-trips to every request, including the survey fetch.
