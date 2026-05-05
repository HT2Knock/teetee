---
'kimaki': minor
---

Allow `kimaki send --user` to work without Discord member search.

The `--user` flag now accepts raw Discord IDs and mentions directly, so servers do not need Server Members Intent just to target a user from the CLI.

```bash
kimaki send --channel 123 --prompt 'Review this' --user '535922349652836367'
kimaki send --channel 123 --prompt 'Review this' --user '<@535922349652836367>'
```

Onboarding now requires only Message Content Intent. If Discord blocks member lookup, Kimaki shows fallback guidance instead of failing with a low-level API error.
