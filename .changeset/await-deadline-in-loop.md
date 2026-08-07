---
"@automatalabs/mcp-server": patch
---

Give the bounded `await` drain loop an in-loop deadline check.

`waitForTerminal` relied solely on a `setTimeout(waitMs)` to end a bounded `await`. When the event
watcher's catch-up monopolized the event loop, that timer could not fire and the `await` overran
its `waitMs` badly. The catch-up itself is now bounded (see `@automatalabs/workflow-engine`), and
the drain loop additionally checks the deadline each iteration, so the `await` returns within its
bound even if the timer callback is briefly starved. Adds an automated `/healthz`-under-drain
acceptance test on a real daemon at the ≥20,000-record / ≥5,000-record-lag magnitude. No contract
change.
