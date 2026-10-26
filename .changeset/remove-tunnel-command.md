---
'kimaki': major
---

Remove `kimaki tunnel`, `TRAFORO_URL` and the `kimaki-tunnel` skill.

Tunnels needed the `traforo` npm package and a relay hosted at `kimaki.dev`, which this fork does not run, so the command could not work here. Dev servers for a Discord preview are no longer supported; run them in `tuistory` instead.

What changes for a running bot:

- `kimaki help` no longer lists a `Tools: tunnel` entry, and `kimaki tunnel -- pnpm dev` is an unknown command
- sessions no longer get the tunnel instruction section in their system prompt
- `--disable-skills` accepts `kimaki-debug` and `kimaki-thread-ops`; `kimaki-tunnel` is rejected
- `traforo` is no longer a dependency, so an install is one package lighter
