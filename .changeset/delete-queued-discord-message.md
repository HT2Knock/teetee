---
'kimaki': patch
'discord-digital-twin': patch
---

Remove local queue items when their Discord message is deleted.

Queued messages can still be edited to update the pending prompt. Now deleting
the original Discord message also removes that prompt from Kimaki's local queue,
so it will not be sent later with the queue drain indicator.

`discord-digital-twin` also exposes `deleteMessage()` on user actors for e2e
tests that need to simulate real Discord `MESSAGE_DELETE` gateway events.
