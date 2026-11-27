# Local Bookmark Organizer

A Chrome Manifest V3 extension that reads bookmark metadata, detects duplicates locally, and uses a
local OpenAI-compatible LLM to propose bookmark folders, cleaner titles, and safe removals.

## Privacy model

- Bookmark titles, URLs, and folder names are sent only to `localhost` or `127.0.0.1`.
- The extension never opens, fetches, or tests bookmark destinations.
- No data is uploaded to a hosted model or remote service.
- Changes are not applied until they are reviewed and selected.
- Deletions are disabled by default; you must enable **Allow deletions** and confirm removals.
- A local undo snapshot is stored for the most recent apply operation.

The model cannot reliably determine whether a page is live or obsolete from its URL alone. Review every
suggested deletion, especially when a local model is configured with a low-quality or small context
window.

## Local server setup

The endpoint field accepts any `localhost` or `127.0.0.1` port. The extension includes presets for
both common OpenAI-compatible endpoints:

| Server | Default API base URL |
|---|---|
| LM Studio | `http://localhost:1234/v1` |
| llama.cpp `llama-server` | `http://localhost:8080/v1` |

For long bookmark lists, analysis runs directly in the extension's Manifest V3 background service
worker, so the popup can be closed. The recommended model batch size is 10 bookmarks. A stalled model
request reports a heartbeat every 15 seconds and, after 120 seconds, is retried with smaller batches.
The organizer requests a compact JSON schema and explicitly disables visible Qwen reasoning. If the
model still returns truncated or invalid output, the extension salvages complete rows, retries once
at a smaller batch size, and switches to deterministic local URL/title organization after two
unusable batches instead of waiting indefinitely.

### LM Studio

1. Install and load a chat model in LM Studio.
2. Start the **Local Server**.
3. Set the server URL to `http://localhost:1234/v1`.
4. Enable CORS for browser access if LM Studio requires it. The extension uses normal extension host
   permissions, but some local-server builds still expose a configurable CORS setting.
5. Open the extension popup and use **Test connection**.

### llama.cpp

1. Start `llama-server` with your GGUF model on port 8080.
2. Confirm the model has an OpenAI-compatible server route at `http://localhost:8080/v1`.
3. Choose the **llama.cpp — localhost:8080/v1** preset in the extension.
4. Select **Test connection**.

Other OpenAI-compatible local servers and custom ports also work when they expose:

- `GET /v1/models`
- `POST /v1/chat/completions`

If the endpoint does not provide `/models`, enter the loaded model ID manually.

## Install in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Select **Load unpacked**.
4. Select this `chrome-bookmark-organizer` directory.
5. Pin **Local Bookmark Organizer** from the Chrome extensions menu.

## Use

1. Open the extension popup.
2. Confirm the local API URL and optionally a model ID.
3. Decide whether to enable **Allow deletions (optional)**.
   - Unchecked (default): organization-only mode (move/rename/keep, no deletions)
   - Checked: deletion proposals are allowed, but still require final confirmation before apply
4. Select **Analyze bookmarks**.
5. You may close the popup. Analysis continues in the extension background and progress is saved.
6. Reopen the popup to resume the live progress view or review the completed plan.
7. Filter and review every proposed action.
8. Uncheck anything that should remain unchanged.
9. If removals are selected, check the explicit deletion confirmation.
10. Select **Apply selected changes**.

If an older run is still shown as active after updating the extension, reload the unpacked extension
once at `chrome://extensions`, reopen the popup, stop that stale run if needed, and start a fresh one.

Use **Stop analysis** to cancel a running background job. Cancellation aborts the active local model
request when supported by the browser. No bookmark changes are made during analysis or cancellation.

The **Activity log** records timestamps for bookmark scanning, model connection, duplicate detection,
batch submission, retry splitting, completion, apply, and undo operations. The log is persisted while
the popup is closed and can be copied or cleared. It intentionally reports observable execution steps,
not hidden model chain-of-thought.

Organized bookmarks are moved in place under **Other bookmarks → AI Organized**. Existing bookmark
folders are not deleted. The most recent operation can be restored with **Undo last changes**.

## Contributor docs

- Implementation guide: [MAINTAINERS_GUIDE.md](./MAINTAINERS_GUIDE.md)
- Auto-loaded coding rule: [.github/instructions/chrome-bookmark-organizer.instructions.md](./.github/instructions/chrome-bookmark-organizer.instructions.md)
- Reusable maintainer skill: [.github/skills/chrome-bookmark-organizer-maintainer/SKILL.md](./.github/skills/chrome-bookmark-organizer-maintainer/SKILL.md)

## Test

No package installation is required.

```powershell
npm test
```

The tests cover duplicate normalization, bookmark-tree flattening, model-response parsing, batch
behavior, plan merging, cancellation, and direct background-worker startup.

If a local model returns malformed JSON, the extension first removes harmless trailing commas. If the
response is still invalid or truncated, the background analyzer recursively retries smaller bookmark
batches. A single bookmark that repeatedly produces invalid output is kept unchanged rather than
blocking the entire plan.
