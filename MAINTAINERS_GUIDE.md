# Local Bookmark Organizer — Maintainer Guide

This guide is the quick onboarding reference for engineers and agents editing the extension.

## Product behavior summary

- The extension analyzes bookmark metadata (title, URL, folder path) with a local OpenAI-compatible API.
- All analysis is **preview-only** until the user applies selected changes.
- Deletions are guarded by two gates:
  1. **Allow deletions (optional)** checkbox (default OFF)
  2. Explicit deletion confirmation before apply

When deletions are disabled, the extension must remain organization-only (move / rename / keep).

## Runtime architecture

### UI layer

- [popup.html](./popup.html) + [popup.js](./popup.js) + [popup.css](./popup.css)
- Handles settings, progress display, activity logs, plan review, and apply/undo actions.

### Analysis worker

- [background.js](./background.js) receives `START_ANALYSIS` and `CANCEL_ANALYSIS`.
- It starts [runAnalysis](./lib/analysis-engine.js) and persists job state in `chrome.storage.local.organizerJob`.

### Core modules

- [llm-client.js](./lib/llm-client.js): endpoint validation, model discovery, structured chat requests.
- [bookmark-core.js](./lib/bookmark-core.js): flattening tree, duplicate detection, JSON parsing, normalization, plan merge.
- [local-classifier.js](./lib/local-classifier.js): deterministic fallback categorization when model output is unusable.
- [chrome-bookmarks.js](./lib/chrome-bookmarks.js): applies move/rename/delete and supports undo snapshot restore.

## Safety invariants (must preserve)

1. **No bookmark changes during analysis**.
2. **Deletion mode OFF** must produce no executable delete actions.
3. Apply still requires explicit deletion consent when deletions are selected.
4. Local fallback is allowed, but never bypasses user review/apply.
5. Only localhost endpoints are accepted.

## Model reliability strategy

1. Request compact JSON schema output with reduced reasoning.
2. Parse strict JSON first, then salvage complete row objects from truncated output.
3. Retry once with smaller sub-batches.
4. If model remains unusable, switch remaining batches to deterministic local classification.

## Common edit recipes

### Add a new category rule

Edit [local-classifier.js](./lib/local-classifier.js):
- Add host + keyword signals in `CATEGORY_RULES`.
- Keep categories short and user-readable.
- Avoid aggressive deletes in local rules.

### Change deletion behavior

You must update all of:
- [popup.js](./popup.js) (checkbox policy and selection logic)
- [analysis-engine.js](./lib/analysis-engine.js) (`allowDeletion` propagation)
- [llm-client.js](./lib/llm-client.js) (prompt/schema action set)
- [local-classifier.js](./lib/local-classifier.js) (delete gating)

## Test commands

```powershell
cd chrome-bookmark-organizer
npm test
node --check popup.js
node --check background.js
node --check lib/analysis-engine.js
node --check lib/llm-client.js
```

Run these after behavior changes; do not skip tests for deletion-path edits.
