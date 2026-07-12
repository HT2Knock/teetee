---
'kimaki': patch
---

Fix `kimaki send` crash with `EACCES` when the process working directory is not writable.

Long prompts (attached as files) now use `os.tmpdir()` instead of `process.cwd()/tmp` for the temporary file, so `kimaki send` works correctly from read-only directories like `/var/www/`.

Fixes #159
