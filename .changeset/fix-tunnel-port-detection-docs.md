---
'kimaki': patch
---

Let `kimaki tunnel -- <dev server>` rely on automatic port detection in the generated agent instructions and onboarding tutorial.

The tunnel command now accepts a child command without `--port`, waits for the dev server output to reveal the localhost port, and keeps `--port` available only for servers that do not print a detectable URL or port line.
