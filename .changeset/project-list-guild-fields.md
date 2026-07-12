---
'kimaki': minor
---

Add guild (server) name and ID to `kimaki project list` output so agents and users can distinguish channels with the same name across different Discord servers.

**Human-readable output** now shows the server name next to each channel:

```
#kimaki (Personal Server)
   Folder: kimaki
   Directory: /Users/morse/.kimaki/projects/kimaki
   Channel ID: 1505879613723906048
   Guild ID: 1422625037164351591
```

**JSON output** (`--json`) includes two new fields:

```json
{
  "channel_id": "...",
  "channel_name": "kimaki",
  "guild_id": "1422625037164351591",
  "guild_name": "Personal Server",
  "directory": "...",
  "folder_name": "kimaki",
  "deleted": false
}
```

**Duplicate directory warning:** when the same directory is registered in multiple channels (across guilds), a warning is printed to stderr recommending `channel_id` for disambiguation.

**New command: `kimaki project remove <channel_id>`** removes a single channel mapping from the local database without deleting the Discord channel. Useful for cleaning up duplicate or stale entries from multi-server setups.
