---
'kimaki': minor
---

Add `--file` option to `kimaki send` for attaching local files (images, text files, PDFs) to Discord messages.

```bash
# Attach a screenshot to a new thread
kimaki send --channel <channelId> --prompt 'Review this screenshot' --file ./screenshot.png

# Attach multiple files to an existing thread
kimaki send --thread <threadId> --prompt 'Here are the logs' --file ./error.log --file ./trace.txt

# Repeatable: attach as many files as needed
kimaki send --channel <channelId> --prompt 'Debug these' --file a.png --file b.pdf --file c.log
```

Files are uploaded as Discord attachments on the starter message. The bot extracts image and PDF attachments and passes them to the AI model as visual context, and text file attachments are inlined into the prompt. File size is validated against Discord's 25 MB limit before upload.

Not compatible with `--send-at` (scheduled tasks store prompts as text and cannot serialize file content).
