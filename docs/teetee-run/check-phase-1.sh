#!/usr/bin/env bash
# Finish condition of the Phase 1 run. Exit 0 only when every check passes.
set -u
cd "$(dirname "$0")/../.." || exit 1
fail=0
check() { if eval "$2"; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s\n' "$1"; fail=1; fi; }

# Removed features leave no source behind.
check 'anthropic plugin gone' 'test ! -d kimaki/src/plugin/anthropic'
check 'voice modules gone' 'test ! -e kimaki/src/voice.ts && test ! -e kimaki/src/voice-call.ts && test ! -e kimaki/src/voice-agent.ts && test ! -e kimaki/src/live-call.ts'
check 'voice deps gone' '! grep -q "@discordjs/voice\|werift\|opusscript\|prism-media\|eventsource-parser" kimaki/package.json'
check 'strada gone' '! grep -q "@strada.sh/sdk" kimaki/package.json && test ! -e kimaki/src/analytics.ts'
check 'gateway flags gone' '! grep -rq -- "--gateway" kimaki/src/cli'
check 'legacy docs gone' 'test ! -e docs/kimaki-v2-rebuild-spec.md && test ! -d .changeset'
check 'no duplicate clone groups' './node_modules/.bin/fallow dupes 2>&1 | grep -qE "No code duplication|No duplicates"'
check 'dead code clean' './node_modules/.bin/fallow dead-code >/dev/null 2>&1'
check 'architecture clean' './node_modules/.bin/fallow architecture >/dev/null 2>&1'
check 'verify passes' 'bun run verify >/dev/null 2>&1'

exit "$fail"
