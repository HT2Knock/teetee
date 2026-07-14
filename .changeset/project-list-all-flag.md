---
'kimaki': minor
---

Add `--all` flag to `kimaki project list` to show projects from other machines.

When multiple kimaki instances share the same Discord server (different machines),
each instance only sees its own locally registered projects. The new `--all` flag
scans the Kimaki category in Discord to discover text channels created by other
instances that are not in the local database.

```bash
# Show local projects only (default, unchanged)
kimaki project list

# Include remote projects from other machines
kimaki project list --all

# Machine-readable output with is_local field
kimaki project list --all --json
```

Remote projects show as `[remote]` in the output with `(Not registered on this machine)`
instead of a directory path. The `--json` output includes `is_local: boolean` and
`directory: null` for remote entries.

Use `--guild <id>` to specify which guild to scan when no local projects exist yet.
