---
'kimaki': patch
---

Respect manual Discord thread renames across title syncs and bot restarts.

Kimaki now stores the last Discord thread name that matched the OpenCode session title. If a user renames the thread after that, future title updates skip the automatic rename instead of overwriting the custom name.

```text
OpenCode title update ─► last synced name matches current Discord name ─► rename thread
OpenCode title update ─► current Discord name was manually changed     ─► keep user name
```

Fixes #115
