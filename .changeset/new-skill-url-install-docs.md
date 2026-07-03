---
'kimaki': patch
---

Document URL-installable skills in the bundled `new-skill` skill.

New section explains how to make a skill installable with
`npx skills add https://example.com` for projects without a public GitHub
repo: the `/.well-known/agent-skills/index.json` v0.2.0 discovery schema,
digest and relative-url rules, a full Spiceflow example serving the SKILL.md
via `?raw` import with a WebCrypto sha256 digest, and the local validation
loop (`skills add http://localhost:3000 --list`).
