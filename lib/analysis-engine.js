import {
  chunk,
  deduplicateFolderNames,
  detectDuplicateActions,
  flattenBookmarks,
  mergeBookmarkPlans
} from "./bookmark-core.js";
import {
  classifyBookmarkBatch,
  discoverModel,
  validateLocalEndpoint
} from "./llm-client.js";
import { appendLogEntry, createLogEntry } from "./job-log.js";
import { classifyBookmarksLocally } from "./local-classifier.js";

const JOB_KEY = "organizerJob";
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_BATCH_SIZE = 20;
const DEFAULT_BATCH_SIZE = 10;
const MAX_RETRY_DEPTH = 1;
let jobUpdateQueue = Promise.resolve();

function idleJob() {
  return {
    status: "idle",
    progress: 0,
    progressMax: 100,
    message: "Ready to analyze bookmarks.",
    plans: [],
    logs: [],
    updatedAt: Date.now()
  };
}

function updateJob(patch) {
  const applyUpdate = async () => {
    const stored = await chrome.storage.local.get(JOB_KEY);
    const current = stored[JOB_KEY] ?? idleJob();
    const logs = patch.log
      ? appendLogEntry(current.logs, createLogEntry(patch.log.level ?? "info", patch.log.message))
      : current.logs ?? [];
    const { log, ...safePatch } = patch;
    const job = {
      ...current,
      ...safePatch,
      logs,
      updatedAt: Date.now()
    };
    await chrome.storage.local.set({ [JOB_KEY]: job });
    return job;
  };

  const queued = jobUpdateQueue.then(applyUpdate, applyUpdate);
  jobUpdateQueue = queued.catch(() => {});
  return queued;
}

async function isCancelled(jobId, signal) {
  if (signal.aborted) {
    return true;
  }
  const stored = await chrome.storage.local.get(JOB_KEY);
  return stored[JOB_KEY]?.id !== jobId || stored[JOB_KEY]?.status === "cancelled";
}

function fallbackActions(bookmarks, reason, existingCategories = [], allowDeletion = true) {
  return classifyBookmarksLocally(bookmarks, existingCategories, reason, {
    allowDeletion
  });
}

function isRecoverableModelError(error, count) {
  const message = error?.message ?? "";
  return count > 1 && (
    /json|position|response|timed out|truncated/i.test(message)
  );
}

async function classifyResiliently({
  jobId,
  endpoint,
  model,
  bookmarks,
  existingCategories,
  allowDeletion,
  depth = 0,
  signal,
  onProgress
}) {
  if (await isCancelled(jobId, signal)) {
    throw new DOMException("Analysis stopped by the user.", "AbortError");
  }

  const startedAt = Date.now();
  let lastHeartbeat = 0;
  const heartbeatId = setInterval(async () => {
    const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    if (signal.aborted || elapsed === lastHeartbeat) {
      return;
    }
    lastHeartbeat = elapsed;
    await updateJob({
      message: `Waiting for ${model} to classify ${bookmarks.length} bookmarks (${elapsed}s elapsed)…`,
      log: {
        level: "info",
        message: `Local model is still processing ${bookmarks.length} bookmark(s); ${elapsed}s elapsed.`
      }
    });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    const result = await classifyBookmarkBatch({
      endpoint,
      model,
      bookmarks,
      existingCategories,
      allowDeletion,
      signal
    });
    const durationSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const usableCount = result.filter((action) => action.source === "llm").length;
    const fallbackCount = result.length - usableCount;
    await updateJob({
      log: {
        level: fallbackCount > 0 ? "warning" : "success",
        message: `Model returned ${usableCount} usable classification(s) in ${durationSeconds}s; ${fallbackCount} omitted row(s) were kept unchanged.`
      }
    });
    onProgress(bookmarks.length);
    return result;
  } catch (error) {
    clearInterval(heartbeatId);
    if (error?.name === "AbortError" || await isCancelled(jobId, signal)) {
      throw new DOMException("Analysis stopped by the user.", "AbortError");
    }

    if (
      !isRecoverableModelError(error, bookmarks.length)
      || bookmarks.length === 1
      || depth >= MAX_RETRY_DEPTH
    ) {
      if (isRecoverableModelError(error, bookmarks.length) || bookmarks.length === 1) {
        onProgress(bookmarks.length);
        await updateJob({
          log: {
            level: "warning",
            message: `Model output was unusable for ${bookmarks.length} bookmark(s). Kept them unchanged to avoid repeated requests.`
          }
        });
        return fallbackActions(
          bookmarks,
          "The local model did not finish valid JSON. This bookmark was organized using local URL and title rules.",
          existingCategories,
          allowDeletion
        );
      }
      throw error;
    }

    await updateJob({
      message: `Recovering the model request by retrying ${bookmarks.length} bookmarks in smaller groups…`,
      log: {
        level: "warning",
        message: `Request for ${bookmarks.length} bookmark(s) failed or timed out. Splitting it into smaller groups (retry depth ${depth + 1}).`
      }
    });
    const midpoint = Math.ceil(bookmarks.length / 2);
    const left = await classifyResiliently({
      jobId,
      endpoint,
      model,
      bookmarks: bookmarks.slice(0, midpoint),
      existingCategories,
      allowDeletion,
      depth: depth + 1,
      signal,
      onProgress
    });
    const right = await classifyResiliently({
      jobId,
      endpoint,
      model,
      bookmarks: bookmarks.slice(midpoint),
      existingCategories,
      allowDeletion,
      depth: depth + 1,
      signal,
      onProgress
    });
    return [...left, ...right];
  } finally {
    clearInterval(heartbeatId);
  }
}

export async function runAnalysis(config, { jobId, signal }) {
  const allowDeletion = config.allowDeletion === true;
  await updateJob({
    id: jobId,
    status: "running",
    progress: 1,
    progressMax: 100,
    stage: "reading",
    message: "Reading Chrome bookmarks in the background worker…",
    plans: [],
    logs: [],
    error: "",
    completedAt: null,
    startedAt: Date.now(),
    log: {
      level: "info",
      message: "Background worker started. The popup can now be closed safely."
    }
  });

  try {
    const endpoint = validateLocalEndpoint(config.endpoint);
    const tree = await chrome.bookmarks.getTree();
    const { bookmarks, folders } = flattenBookmarks(tree);
    if (bookmarks.length === 0) {
      throw new Error("No bookmarks were found.");
    }

    await updateJob({
      stage: "connecting",
      progress: 4,
      message: `Found ${bookmarks.length} bookmarks. Connecting to the local model…`,
      log: {
        level: "success",
        message: `Read ${bookmarks.length} bookmarks from ${folders.length} existing folders.`
      }
    });
    const model = await discoverModel(endpoint, config.model);
    await updateJob({
      model,
      log: { level: "success", message: `Connected to the local model "${model}".` }
    });

    const duplicateActions = detectDuplicateActions(bookmarks, { allowDeletion });
    const duplicateIds = new Set(duplicateActions.map((action) => action.id));
    const toClassify = bookmarks.filter((bookmark) => !duplicateIds.has(bookmark.id));
    const existingCategories = deduplicateFolderNames(folders.map((folder) => folder.path));
    const requestedBatchSize = Number(config.batchSize);
    const batchSize = Number.isInteger(requestedBatchSize) && requestedBatchSize > 0
      ? Math.min(requestedBatchSize, MAX_BATCH_SIZE)
      : DEFAULT_BATCH_SIZE;
    const batches = chunk(toClassify, batchSize);
    const modelActions = [];
    let processed = 0;
    let consecutiveUnusableBatches = 0;
    let usingLocalFallback = false;

    await updateJob({
      stage: "duplicates",
      log: {
        level: "info",
        message: `Local duplicate scan marked ${duplicateActions.length} duplicate(s). Prepared ${batches.length} model batch(es) of up to ${batchSize} bookmarks. Deletion mode is ${allowDeletion ? "enabled" : "disabled (organization-only)"}.`
      }
    });

    for (let index = 0; index < batches.length; index += 1) {
      if (await isCancelled(jobId, signal)) {
        throw new DOMException("Analysis stopped by the user.", "AbortError");
      }

      await updateJob({
        stage: "model",
        progress: processed,
        progressMax: toClassify.length,
        model,
        currentBatch: index + 1,
        totalBatches: batches.length,
        message: `Analyzing batch ${index + 1} of ${batches.length} with ${model}…`,
        log: {
          level: "info",
          message: `Sending batch ${index + 1}/${batches.length} (${batches[index].length} bookmarks) to ${model}.`
        }
      });
      let actions;
      if (usingLocalFallback) {
        actions = classifyBookmarksLocally(
          batches[index],
          existingCategories,
          "The model was unreliable for earlier batches, so this bookmark was organized locally by domain and title.",
          { allowDeletion }
        );
        processed += batches[index].length;
      } else {
        actions = await classifyResiliently({
          jobId,
          endpoint,
          model,
          bookmarks: batches[index],
          existingCategories,
          allowDeletion,
          signal,
          onProgress: (count) => {
            processed += count;
          }
        });
      }
      const usableActions = actions.filter((action) => action.source === "llm").length;
      consecutiveUnusableBatches = usableActions === 0
        ? consecutiveUnusableBatches + 1
        : 0;
      if (!usingLocalFallback && consecutiveUnusableBatches >= 2) {
        usingLocalFallback = true;
        await updateJob({
          stage: "local",
          message: "The model is returning unusable output. Continuing with local domain/title organization…",
          log: {
            level: "warning",
            message: "Model output failed for two consecutive batches. Switching the remaining bookmarks to deterministic local organization."
          }
        });
      }
      modelActions.push(...actions);
      await updateJob({
        progress: processed,
        progressMax: toClassify.length,
        message: `Analyzed ${processed} of ${toClassify.length} bookmarks…`,
        log: {
          level: "success",
          message: `Batch ${index + 1}/${batches.length} completed. ${processed}/${toClassify.length} model classifications processed.`
        }
      });
    }

    if (await isCancelled(jobId, signal)) {
      throw new DOMException("Analysis stopped by the user.", "AbortError");
    }

    await updateJob({
      stage: "building",
      message: "Merging duplicate and model recommendations into a review plan…",
      log: { level: "info", message: "Building the final review plan. No bookmarks will be changed." }
    });
    const result = mergeBookmarkPlans(bookmarks, duplicateActions, modelActions);
    const changes = result.filter((plan) => plan.action !== "keep").length;
    const deletes = result.filter((plan) => plan.action === "delete").length;
    await chrome.storage.local.set({
      organizerSettings: { ...config, endpoint, model }
    });
    await updateJob({
      status: "completed",
      stage: "review",
      progress: 1,
      progressMax: 1,
      model,
      plans: result,
      message: `Review ${changes} proposed changes. No bookmarks have been changed.`,
      completedAt: Date.now(),
      log: {
        level: "success",
        message: `Analysis complete: ${changes} proposed change(s), including ${deletes} removal(s). ${
          result.some((plan) => plan.source === "local")
            ? "Some classifications used local fallback rules because the model output was unavailable. "
            : ""
        }${allowDeletion ? "Deletion mode was enabled. " : "Organization-only mode disabled deletions. "}No bookmarks were modified.`
      }
    });
  } catch (error) {
    const cancelled = error?.name === "AbortError";
    await updateJob({
      status: cancelled ? "cancelled" : "failed",
      stage: "stopped",
      message: cancelled ? "Analysis stopped. No bookmarks were changed." : error.message,
      error: cancelled ? "" : error.message,
      log: {
        level: cancelled ? "warning" : "error",
        message: cancelled
          ? "Analysis cancelled. No bookmarks were modified."
          : `Analysis failed: ${error.message}`
      }
    });
  }
}
