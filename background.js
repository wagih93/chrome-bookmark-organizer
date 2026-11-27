import { runAnalysis } from "./lib/analysis-engine.js";

const JOB_KEY = "organizerJob";

let activeController = null;
let activeRun = null;

async function readJob() {
  const stored = await chrome.storage.local.get(JOB_KEY);
  return stored[JOB_KEY] ?? null;
}

async function updateJob(patch) {
  const current = await readJob();
  const job = {
    ...(current ?? {}),
    ...patch,
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ [JOB_KEY]: job });
  return job;
}

async function waitForJobStart(jobId, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await readJob();
    if (job?.id === jobId) {
      if (job.status === "running" || job.status === "completed") {
        return job;
      }
      throw new Error(job.error || job.message || "Analysis stopped during startup.");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The background worker did not acknowledge startup.");
}

async function startAnalysis(config) {
  if (activeRun) {
    return { ok: false, error: "A background analysis is already running." };
  }

  const existingJob = await readJob();
  if (existingJob?.status === "running") {
    await updateJob({
      status: "failed",
      stage: "interrupted",
      message: "The previous background worker was interrupted. Starting a fresh analysis.",
      error: "Previous background worker no longer active."
    });
  }

  const jobId = crypto.randomUUID();
  activeController = new AbortController();
  activeRun = runAnalysis(config, {
    jobId,
    signal: activeController.signal
  }).finally(() => {
    activeController = null;
    activeRun = null;
  });

  try {
    await waitForJobStart(jobId);
    return { ok: true, jobId };
  } catch (error) {
    activeController?.abort();
    await activeRun;
    return { ok: false, error: error.message };
  }
}

async function cancelAnalysis() {
  activeController?.abort();
  await updateJob({
    status: "cancelled",
    stage: "stopping",
    message: "Stopping the local model request… no bookmarks will be changed."
  });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_ANALYSIS") {
    startAnalysis(message.config)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CANCEL_ANALYSIS") {
    cancelAnalysis()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_ANALYSIS_STATUS") {
    readJob()
      .then((job) => sendResponse({ ok: true, job }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.runtime.onStartup.addListener(async () => {
  const job = await readJob();
  if (job?.status === "running") {
    await updateJob({
      status: "failed",
      stage: "interrupted",
      message: "The browser restarted before analysis completed. Start again; no bookmarks were changed.",
      error: "Analysis interrupted by browser restart."
    });
  }
});
