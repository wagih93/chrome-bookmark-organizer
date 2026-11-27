import test from "node:test";
import assert from "node:assert/strict";

test("background worker starts analysis and completes through the Chrome message handler", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const storage = {};
  let messageListener;

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
              title: "Work",
              children: [{
                id: "11",
                parentId: "10",
                index: 0,
                title: "Reference",
                url: "https://example.com/reference"
              }]
            }]
          }]
        }];
      }
    },
    runtime: {
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        }
      },
      onStartup: {
        addListener() {}
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
        data: [{ id: "test-model" }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            r: [{
              i: "11",
              a: "k"
            }]
          })
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    await import(`../background.js?test=${Date.now()}`);
    assert.equal(typeof messageListener, "function");

    const response = await new Promise((resolve, reject) => {
      const keepsChannelOpen = messageListener({
        type: "START_ANALYSIS",
        config: {
          endpoint: "http://localhost:1234/v1",
          model: "",
          batchSize: 10
        }
      }, {}, resolve);
      assert.equal(keepsChannelOpen, true);
      setTimeout(() => reject(new Error("Background startup timed out.")), 5000).unref();
    });

    assert.equal(response.ok, true);
    assert.ok(response.jobId);

    const deadline = Date.now() + 5000;
    while (storage.organizerJob?.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(storage.organizerJob.status, "completed");
    assert.equal(storage.organizerJob.plans.length, 1);
    assert.match(storage.organizerJob.logs[0].message, /Background worker started/);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});
