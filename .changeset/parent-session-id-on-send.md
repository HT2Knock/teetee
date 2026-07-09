---
'kimaki': minor
---

Pass parent session IDs when spawning child sessions via `kimaki send`.

New sessions started from an existing session should include `--parent-session <id>` so the child knows who started it and can message back only when the user asks.

**Parent side (spawn examples now always include parent session):**

```bash
kimaki send --channel <channelId> \
  --prompt 'Help with this task' \
  --agent build \
  --parent-session ses_current
```

**Child side (system message when parent was passed):**

```text
Your parent OpenCode session ID is: ses_current
You can send a message back to the parent session with:
kimaki send --session ses_current --prompt 'your update here' --agent <current_agent>
Do NOT message the parent session unless the user explicitly asks you to.
```

The flag is optional for manual/CLI use. Agents are instructed to always pass their current session ID when starting a new session.
