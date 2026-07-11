---
'kimaki': patch
---

Retry Discord connection after transient TLS certificate errors instead of permanently stopping the bot.

Previously, startup failures like `unable to verify the first certificate` exited with code 64 (`EXIT_NO_RESTART`), so the auto-restart wrapper never recovered. Those TLS blips (and similar cert chain errors) now count as transient network errors and exit with code 1 so kimaki restarts with backoff.

```
Discord login TLS failure
        │
        ▼
isTransientNetworkError?  ── yes (cert codes / message)
        │
        ▼
exit 1  ──► bin wrapper restarts with backoff
```
