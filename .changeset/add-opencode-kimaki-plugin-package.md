---
'@kimaki/opencode-plugin': minor
---

Add `@kimaki/opencode-plugin` package for standalone OpenCode Anthropic OAuth support.

Users can add Claude Pro/Max subscription support to OpenCode without the Discord bot:

```json
{ "plugin": ["@kimaki/opencode-plugin"] }
```

Features included:
- OAuth PKCE login flow for Claude Pro/Max subscriptions
- Automatic token refresh with deduplication
- System prompt rewriting (OpenCode identity → Claude Code identity)
- Tool name mapping so Anthropic API recognizes OpenCode tools
- Beta header injection
- Multi-account store with automatic rotation on rate limits
- Cost zeroing for OAuth users
