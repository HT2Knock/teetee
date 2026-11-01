# Phase 1 autonomous run

## Finish condition

`bash docs/teetee-run/check-phase-1.sh` exits 0. It checks:

- the removed features are gone from `kimaki/src` and `package.json`
- `fallow dead-code`, `fallow architecture`, and `fallow dupes` pass
- `bun run verify` passes
- the full test suite passes

## Isolation

One operator, no other open work, and CI as the gate. The run uses the real
checkout on `main` instead of a worktree, so the installed dependencies and the
generated Prisma client are the same ones CI uses. A worktree would need a
second install and generate step for no collision benefit.

## Stop conditions

- The finish condition passes.
- A step needs a Discord application, a bot token, or an operator action
  (Phase 6 cutover, service restart).
- Two consecutive iterations leave the check red for the same reason.

## Decision log

`docs/teetee-run/decisions.tsv`, one row per iteration.
