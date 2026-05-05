---
'kimaki': minor
---

Add multi-provider OAuth account rotation for Anthropic and OpenAI.

Kimaki now has a unified `multioauth` CLI namespace for managing OAuth account pools across providers:

```bash
kimaki multioauth list
kimaki multioauth anthropic list
kimaki multioauth anthropic current
kimaki multioauth openai list
kimaki multioauth openai current
kimaki multioauth openai check
```

OpenAI OAuth accounts are remembered separately, can rotate on rate-limit retries, and display identity metadata extracted from access tokens when available.
