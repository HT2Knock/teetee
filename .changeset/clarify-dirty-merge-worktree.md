---
'kimaki': patch
---

Make `/merge-worktree` failures clearer when the target worktree has uncommitted changes.

Kimaki now checks the checked-out target branch before the local fast-forward push. If the target worktree is dirty, the Discord error tells the user to commit or clean the main worktree first instead of surfacing a generic git push failure.
