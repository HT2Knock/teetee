---
'kimaki': patch
---

Show a clear Discord instruction when message content is not readable.

When Discord withholds text because Message Content Intent is unavailable, Kimaki now tells the user to mention the bot and resend the prompt instead of creating an empty thread or sending an empty request to OpenCode. The warning also points users to `--mention-mode` for servers that intentionally avoid the privileged intent.
