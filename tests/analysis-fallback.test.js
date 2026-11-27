import test from "node:test";
import assert from "node:assert/strict";

import { runAnalysis } from "../lib/analysis-engine.js";

test("analysis completes with local rules after consecutive malformed model responses", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const storage = {};
  const bookmarks = Array.from({ length: 20 }, (_, index) => ({
    id: String(index + 1),
    parentId: "10",
    index,
    title: `GitHub development project ${index + 1}`,
    url: `https://github.com/example/repo-${index + 1}`
  }));

  globalThis.chrome = {
    bookmarks: {
      async getTree() {
        return [{
          id: "0",
          children: [{
            id: "2",
            parentId: "0",
            title: "Other bookmarks",
            children: [{
              id: "10",
              parentId: "2",
              title: "Inbox",
              children: bookmarks
            }]
          }]
        }];
      }
    },
    storage: {
      local: {
        async get(key) {
          return key === undefined ? { ...storage } : { [key]: storage[key] };
        },
        async set(values) {
          Object.assign(storage, values);
        }
      }
    }
  };
  globalThis.fetch = async (url) => {
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({
        data: [{ id: "broken-model" }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({
      choices: [{
        finish_reason: "length",
        message: {
          content: "{\"r\":[{\"i\":\"1\"",
          reasoning_content: "x".repeat(2000)
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    await runAnalysis({
      endpoint: "http://localhost:1234/v1",
      model: "broken-model",
      batchSize: 10
    }, {
      jobId: "fallback-job",
      signal: new AbortController().signal
    });

    assert.equal(storage.organizerJob.status, "completed");
    assert.equal(storage.organizerJob.plans.length, 20);
    assert.equal(storage.organizerJob.plans.filter((plan) => plan.source === "local").length, 20);
    assert.ok(storage.organizerJob.logs.some((entry) => (
      entry.message.includes("Switching the remaining bookmarks to deterministic local organization")
    )));
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});
