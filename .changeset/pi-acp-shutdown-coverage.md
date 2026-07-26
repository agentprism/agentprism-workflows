---
"@automatalabs/pi-acp": patch
---

Cover the three teardown paths the `session_shutdown` fix left unverified: the failed-open branch (`FailedOpenCleanup`, which owns cleanup when pi exists but the session never became publishable), asynchronous extension handlers (proving disposal awaits `emit()` rather than racing past it), and many sessions in one process — the pooled/parallel shape the leak actually threatened. Each fails without the fix; with the emit removed all five children in the multi-session case survive, which is the per-process accumulation the bug caused.
