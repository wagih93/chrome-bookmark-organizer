---
description: "Use when editing the Chrome bookmark organizer extension files."
applyTo: "**/*.{js,html,css,json,md}"
---

# Chrome Bookmark Organizer Rules

## 1) Safety and deletion policy

- `allowDeletion` defaults to `false`.
- When `allowDeletion` is `false`, no delete action may be executable in apply flow.
- Keep both deletion gates:
  1. "Allow deletions (optional)" toggle
  2. explicit deletion confirmation before apply.

## 2) Background analysis contract

- Analysis must run through `background.js` + `runAnalysis` in `lib/analysis-engine.js`.
- Persist progress and activity logs to `chrome.storage.local.organizerJob`.
- Never mutate bookmarks during analysis.

## 3) Model reliability behavior

- Keep compact structured outputs and bounded retries.
- If model outputs are unusable, salvage partial valid rows when possible.
- After repeated unusable batches, switch remaining items to deterministic local classification instead of looping.

## 4) Data/privacy constraints

- Accept only `http://localhost` and `http://127.0.0.1` endpoints.
- Do not add remote hosts or cloud fallbacks.
- Never fetch bookmark page content; only process metadata.

## 5) Required validation after edits

Run at minimum:

```powershell
cd chrome-bookmark-organizer
npm test
node --check popup.js
node --check background.js
node --check lib/analysis-engine.js
node --check lib/llm-client.js
```
