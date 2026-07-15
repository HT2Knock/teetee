---
'kimaki': minor
---

Auto-resolve the best remote ref when creating worktrees with `--base-branch`.

When the user specifies a base branch like `main`, kimaki now fetches the latest
from `upstream` (then `origin`) and uses the remote ref if it's strictly ahead of
the local branch. This avoids creating worktrees from stale local branches.

```
/new-worktree name:my-feature base-branch:main
# local main is 3 commits behind upstream/main
# → worktree is created from upstream/main automatically
```

If local and remote have diverged (both ahead and behind), the local branch is
used to avoid needing a merge. Explicit remote refs like `origin/main` are passed
through unchanged. All fetches are best-effort with a 15s timeout; network
failures fall back to the local branch silently.

Closes #138
