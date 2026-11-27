const ORGANIZER_ROOT_TITLE = "AI Organized";
const BACKUP_KEY = "lastBookmarkBackup";

function folderPathSignature(parentId, segments) {
  return `${parentId}\u0000${segments.join("\u0000")}`;
}

async function resolveOtherBookmarksRoot() {
  const tree = await chrome.bookmarks.getTree();
  const root = tree[0]?.children ?? [];
  const other = root.find((node) => node.title === "Other bookmarks")
    ?? root.find((node) => node.title !== "Bookmarks bar" && node.children);
  if (!other) {
    throw new Error("Chrome's bookmark folders could not be found.");
  }
  return other;
}

async function ensureFolderPath(rootId, segments, cache) {
  let parentId = rootId;
  let builtPath = [];

  for (const requestedSegment of segments) {
    builtPath = [...builtPath, requestedSegment];
    const signature = folderPathSignature(parentId, builtPath);
    if (cache.has(signature)) {
      parentId = cache.get(signature);
      continue;
    }

    const children = await chrome.bookmarks.getChildren(parentId);
    const existing = children.find((child) => !child.url && child.title === requestedSegment);
    if (existing) {
      parentId = existing.id;
    } else {
      const created = await chrome.bookmarks.create({
        parentId,
        title: requestedSegment
      });
      parentId = created.id;
    }
    cache.set(signature, parentId);
  }

  return parentId;
}

export async function applyBookmarkPlan(plans) {
  const selected = plans.filter((plan) => plan.selected && plan.action !== "keep");
  if (selected.length === 0) {
    throw new Error("Select at least one proposed change.");
  }

  const originals = selected.map((plan) => ({
    id: plan.bookmark.id,
    parentId: plan.bookmark.parentId,
    index: plan.bookmark.index,
    title: plan.bookmark.title,
    url: plan.bookmark.url,
    action: plan.action
  }));
  const backup = {
    createdAt: new Date().toISOString(),
    originals
  };
  await chrome.storage.local.set({ [BACKUP_KEY]: backup });

  let organizerRoot;
  if (selected.some((plan) => plan.action === "move")) {
    const otherRoot = await resolveOtherBookmarksRoot();
    const organizerChildren = await chrome.bookmarks.getChildren(otherRoot.id);
    organizerRoot = organizerChildren.find(
      (child) => !child.url && child.title === ORGANIZER_ROOT_TITLE
    );
    if (!organizerRoot) {
      organizerRoot = await chrome.bookmarks.create({
        parentId: otherRoot.id,
        title: ORGANIZER_ROOT_TITLE
      });
    }
  }

  const folderCache = new Map();
  const results = {
    moved: 0,
    renamed: 0,
    deleted: 0
  };

  for (const plan of selected) {
    if (plan.action === "delete") {
      await chrome.bookmarks.remove(plan.bookmark.id);
      results.deleted += 1;
      continue;
    }

    if (plan.action === "move") {
      const targetParent = await ensureFolderPath(
        organizerRoot.id,
        plan.folderPath.length ? plan.folderPath : ["Unsorted"],
        folderCache
      );
      await chrome.bookmarks.move(plan.bookmark.id, { parentId: targetParent });
      results.moved += 1;
    }

    if (plan.bookmark.title !== plan.title) {
      await chrome.bookmarks.update(plan.bookmark.id, { title: plan.title });
      results.renamed += 1;
    }
  }

  return results;
}

export async function hasUndoBackup() {
  const stored = await chrome.storage.local.get(BACKUP_KEY);
  return Boolean(stored[BACKUP_KEY]?.originals?.length);
}

export async function undoLastBookmarkPlan() {
  const stored = await chrome.storage.local.get(BACKUP_KEY);
  const backup = stored[BACKUP_KEY];
  if (!backup?.originals?.length) {
    throw new Error("No bookmark changes are available to undo.");
  }

  const failures = [];
  for (const original of [...backup.originals].reverse()) {
    try {
      if (original.action === "delete") {
        await chrome.bookmarks.create({
          parentId: original.parentId,
          index: original.index,
          title: original.title,
          url: original.url
        });
      } else {
        await chrome.bookmarks.update(original.id, { title: original.title });
        await chrome.bookmarks.move(original.id, {
          parentId: original.parentId,
          index: original.index
        });
      }
    } catch (error) {
      failures.push({
        id: original.id,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} bookmark(s) could not be restored. The backup was kept for another attempt.`);
  }

  await chrome.storage.local.remove(BACKUP_KEY);
  return backup.originals.length;
}
