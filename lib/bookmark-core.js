const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "ref_src",
  "ref_url"
]);

export function flattenBookmarks(tree) {
  const bookmarks = [];
  const folders = [];

  function visit(nodes, path) {
    for (const node of nodes) {
      if (node.url) {
        bookmarks.push({
          id: node.id,
          parentId: node.parentId,
          title: node.title || "(untitled)",
          url: node.url,
          path: [...path],
          index: node.index ?? 0,
          dateAdded: node.dateAdded ?? 0
        });
      } else {
        const childPath = node.id === "0"
          ? path
          : [...path, node.title].filter(Boolean);

        if (node.id !== "0") {
          folders.push({
            id: node.id,
            parentId: node.parentId,
            title: node.title,
            path: childPath
          });
        }

        visit(node.children ?? [], childPath);
      }
    }
  }

  visit(tree, []);
  return { bookmarks, folders };
}

export function normalizeBookmarkUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = "";

    if (url.protocol === "http:" || url.protocol === "https:") {
      url.hostname = url.hostname.toLowerCase();

      for (const key of [...url.searchParams.keys()]) {
        const lowerKey = key.toLowerCase();
        if (lowerKey.startsWith("utm_") || TRACKING_PARAMETERS.has(lowerKey)) {
          url.searchParams.delete(key);
        }
      }

      url.searchParams.sort();
      if (url.pathname !== "/") {
        url.pathname = url.pathname.replace(/\/+$/, "");
      }
    }

    return url.toString();
  } catch {
    return rawUrl.trim();
  }
}

export function detectDuplicateActions(bookmarks, options = {}) {
  const allowDeletion = options.allowDeletion !== false;
  if (!allowDeletion) {
    return [];
  }
  const groups = new Map();

  for (const bookmark of bookmarks) {
    const normalized = normalizeBookmarkUrl(bookmark.url);
    const group = groups.get(normalized) ?? [];
    group.push(bookmark);
    groups.set(normalized, group);
  }

  const actions = [];
  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }

    const sorted = [...group].sort((left, right) => {
      const byDate = left.dateAdded - right.dateAdded;
      return byDate || left.id.localeCompare(right.id);
    });
    const keeper = sorted[0];

    for (const duplicate of sorted.slice(1)) {
      actions.push({
        id: duplicate.id,
        action: "delete",
        title: duplicate.title,
        folderPath: duplicate.path,
        reason: `Exact duplicate of "${keeper.title}" (${keeper.path.join(" / ") || "root"}).`,
        confidence: 1,
        source: "duplicate"
      });
    }
  }

  return actions;
}

export function deduplicateFolderNames(paths) {
  return [...new Set(paths
    .filter((path) => Array.isArray(path) && path.length > 0)
    .map((path) => stripChromeRootFolders(path)[0])
    .filter(Boolean))]
    .slice(0, 30);
}

function stripChromeRootFolders(path) {
  const chromeRoots = new Set([
    "Bookmarks bar",
    "Other bookmarks",
    "Mobile bookmarks",
    "AI Organized"
  ]);
  return path.filter((segment) => !chromeRoots.has(segment));
}

export function chunk(items, size) {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error("Batch size must be a positive integer.");
  }

  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export function parseJsonObjectResponse(content) {
  if (typeof content !== "string") {
    throw new Error("The local model returned an empty response.");
  }

  let candidate = content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    candidate = fenced[1].trim();
  }

  const attempts = [
    candidate,
    candidate.replace(/,\s*([}\]])/g, "$1")
  ];

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // Continue with bounded extraction and cleanup attempts.
    }
  }

  const extracted = [];
  {
    const arrayStart = candidate.indexOf("[");
    const arrayEnd = candidate.lastIndexOf("]");
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      extracted.push(candidate.slice(arrayStart, arrayEnd + 1));
    }

    const objectStart = candidate.indexOf("{");
    const objectEnd = candidate.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      extracted.push(candidate.slice(objectStart, objectEnd + 1));
    }
  }

  for (const attempt of extracted) {
    try {
      return JSON.parse(attempt.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      // A malformed batch is retried in smaller groups by the background worker.
    }
  }

  const salvagedRows = [];
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] !== "{") {
      continue;
    }
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let cursor = index; cursor < candidate.length; cursor += 1) {
      const character = candidate[cursor];
      if (quoted) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === "\"") {
          quoted = false;
        }
        continue;
      }
      if (character === "\"") {
        quoted = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          const row = candidate.slice(index, cursor + 1).replace(/,\s*([}\]])/g, "$1");
          try {
            const parsed = JSON.parse(row);
            if (parsed && (parsed.id !== undefined || parsed.i !== undefined)) {
              salvagedRows.push(parsed);
            }
          } catch {
            // Continue looking for complete row objects.
          }
          index = cursor;
          break;
        }
      }
    }
  }

  if (salvagedRows.length > 0) {
    const uniqueRows = [...new Map(
      salvagedRows.map((row) => [String(row.id ?? row.i), row])
    ).values()];
    return { bookmarks: uniqueRows };
  }

  throw new Error("The local model returned malformed JSON. Retrying this batch in smaller groups.");
}

export function normalizeModelActions(payload, expectedBookmarks, options = {}) {
  const allowDeletion = options.allowDeletion !== false;
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.bookmarks)
      ? payload.bookmarks
      : Array.isArray(payload?.r)
        ? payload.r
        : null;

  if (!rows) {
    throw new Error('The model response must be an array or an object with a "bookmarks" array.');
  }

  const expected = new Map(expectedBookmarks.map((bookmark) => [bookmark.id, bookmark]));
  const actions = [];

  for (const row of rows) {
    const bookmark = expected.get(String(row?.id ?? row?.i));
    if (!bookmark) {
      continue;
    }

    const compactActions = {
      k: "keep",
      m: "move",
      r: "rename",
      d: "delete"
    };
    const rawAction = String(row.action ?? row.a ?? "keep").toLowerCase();
    let action = compactActions[rawAction] ?? rawAction;
    if (!["keep", "move", "rename", "delete"].includes(action)) {
      action = "keep";
    }
    if (!allowDeletion && action === "delete") {
      action = "keep";
    }

    const confidenceValue = Number(row.confidence ?? 0.8);
    const confidence = Number.isFinite(confidenceValue)
      ? Math.max(0, Math.min(1, confidenceValue))
      : 0.5;
    const proposedTitle = String(row.title ?? row.n ?? bookmark.title).trim().slice(0, 180);
    const rawFolderPath = row.folderPath ?? (
      typeof row.c === "string"
        ? row.c.split("/").map((segment) => segment.trim()).filter(Boolean)
        : undefined
    );
    const defaultReason = action === "delete"
      ? "The local model flagged this bookmark as low-value clutter."
      : action === "move"
        ? "The local model suggested a more specific folder."
        : action === "rename"
          ? "The local model suggested a clearer title."
          : "The local model found this bookmark useful.";
    const reason = String(row.reason ?? row.x ?? defaultReason).trim().slice(0, 400);
    const folderPath = Array.isArray(rawFolderPath)
      ? stripChromeRootFolders(rawFolderPath)
        .map((segment) => String(segment).replace(/[\\/:*?"<>|]/g, " ").trim().slice(0, 60))
        .filter(Boolean)
        .slice(0, 4)
      : stripChromeRootFolders(bookmark.path);

    actions.push({
      id: bookmark.id,
      action,
      title: proposedTitle || bookmark.title,
      folderPath,
      reason,
      confidence,
      source: "llm"
    });
  }

  return expectedBookmarks.map((bookmark) => {
    return actions.find((action) => action.id === bookmark.id) ?? {
      id: bookmark.id,
      action: "keep",
      title: bookmark.title,
      folderPath: bookmark.path,
      reason: "The model did not classify this bookmark, so it remains unchanged.",
      confidence: 0,
      source: "fallback"
    };
  });
}

export function mergeBookmarkPlans(bookmarks, duplicateActions, modelActions) {
  const duplicateById = new Map(duplicateActions.map((action) => [action.id, action]));
  const modelById = new Map(modelActions.map((action) => [action.id, action]));

  return bookmarks.map((bookmark) => {
    const action = duplicateById.get(bookmark.id) ?? modelById.get(bookmark.id) ?? {
      id: bookmark.id,
      action: "keep",
      title: bookmark.title,
      folderPath: bookmark.path,
      reason: "No action proposed.",
      confidence: 0,
      source: "fallback"
    };

    const proposedTitle = action.title?.trim() || bookmark.title;
    const currentOrganizablePath = stripChromeRootFolders(bookmark.path);
    const locationChanged = action.folderPath.join("\u0000") !== currentOrganizablePath.join("\u0000");
    const titleChanged = proposedTitle !== bookmark.title;
    let operation = action.action;

    if (operation === "move" && !locationChanged) {
      operation = titleChanged ? "rename" : "keep";
    } else if (operation === "rename" && !titleChanged) {
      operation = "keep";
    }

    return {
      ...action,
      action: operation,
      title: proposedTitle,
      bookmark
    };
  });
}

export function planSearchText(plan) {
  return [
    plan.bookmark.title,
    plan.bookmark.url,
    plan.bookmark.path.join(" / "),
    plan.title,
    plan.folderPath.join(" / "),
    plan.reason,
    plan.action
  ].join(" ").toLowerCase();
}
