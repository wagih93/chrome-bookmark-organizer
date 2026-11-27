---
name: chrome-bookmark-organizer-maintainer
description: Maintain and extend the local Chrome bookmark organizer extension with safe deletion controls, resilient local-LLM classification, and background job reliability.
---

# Chrome Bookmark Organizer Maintainer

Use this skill when editing the [Chrome bookmark organizer project](../../../).

## Goals

1. Keep analysis local-first and background-safe.
2. Preserve preview-before-apply and undo guarantees.
3. Keep deletion handling conservative and explicit.
4. Prevent model-output failures from blocking completion.

## File map

- UI: [popup.html](../../../popup.html), [popup.js](../../../popup.js), [popup.css](../../../popup.css)
- Worker entry: [background.js](../../../background.js)
- Engine: [analysis-engine.js](../../../lib/analysis-engine.js)
- LLM adapter: [llm-client.js](../../../lib/llm-client.js)
- Core transform/parsing: [bookmark-core.js](../../../lib/bookmark-core.js)
- Local fallback rules: [local-classifier.js](../../../lib/local-classifier.js)
- Apply/undo: [chrome-bookmarks.js](../../../lib/chrome-bookmarks.js)

## Non-negotiable invariants

- Analysis never changes bookmarks.
- Delete actions are blocked when `allowDeletion` is false.
- Applying deletions requires explicit deletion confirmation.
- Only localhost model endpoints are accepted.
- If LLM output is repeatedly unusable, finish using deterministic local classification.

## Change checklist

When you touch deletion behavior, update all coupled modules:

- [popup.js](../../../popup.js)
- [analysis-engine.js](../../../lib/analysis-engine.js)
- [llm-client.js](../../../lib/llm-client.js)
- [bookmark-core.js](../../../lib/bookmark-core.js)
- [local-classifier.js](../../../lib/local-classifier.js)

## Validation

```powershell
npm test
node --check popup.js
node --check background.js
node --check lib/analysis-engine.js
node --check lib/llm-client.js
```
