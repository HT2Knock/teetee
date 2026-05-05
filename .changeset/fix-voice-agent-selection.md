---
'kimaki': patch
---

Fix voice agent selection so casual uses of agent names do not switch the active agent.

Voice prompts now only use the agent-selection shortcut when the message clearly starts with an agent command phrase. A message like "ask the build agent what changed" stays as a normal prompt instead of accidentally changing the session agent.
