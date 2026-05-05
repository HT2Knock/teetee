---
'kimaki': patch
---

Fix Anthropic OAuth requests so project instructions are preserved.

The Anthropic system prompt sanitizer now removes only the OpenCode identity and adjacent environment block. This keeps project instructions, skill instructions, and configured agent context intact even when OpenCode changes the order of system prompt sections.

Fixes #116
