import test from "node:test";
import assert from "node:assert/strict";

import {
  chunk,
  deduplicateFolderNames,
  detectDuplicateActions,
  flattenBookmarks,
  mergeBookmarkPlans,
  normalizeBookmarkUrl,
  normalizeModelActions,
  parseJsonObjectResponse
} from "../lib/bookmark-core.js";
import {
  classifyBookmarkBatch,
  validateLocalEndpoint
} from "../lib/llm-client.js";
import { classifyBookmarksLocally } from "../lib/local-classifier.js";
import {
  appendLogEntry,
  createLogEntry,
  formatLogEntry,
  MAX_LOG_ENTRIES
} from "../lib/job-log.js";

test("flattenBookmarks records bookmark and folder paths", () => {
  const tree = [{
    id: "0",
    children: [{
      id: "2",
      title: "Other bookmarks",
      children: [{
        id: "10",
        title: "Development",
        children: [{
          id: "11",
          parentId: "10",
          index: 0,
          title: "Node",
          url: "https://nodejs.org"
        }]
      }]
    }]
  }];

  const result = flattenBookmarks(tree);
  assert.equal(result.bookmarks[0].path.join(" / "), "Other bookmarks / Development");
  assert.equal(result.folders.at(-1).title, "Development");
});

test("normalizeBookmarkUrl removes tracking parameters and trailing slash", () => {
  assert.equal(
    normalizeBookmarkUrl("HTTPS://Example.com/docs/?utm_source=test&b=2&a=1#top"),
    "https://example.com/docs?a=1&b=2"
  );
});

test("detectDuplicateActions keeps the oldest exact URL", () => {
  const bookmarks = [
    { id: "old", title: "Old", url: "https://example.com/?utm_source=x", path: ["Work"], dateAdded: 1 },
    { id: "new", title: "New", url: "https://example.com/", path: ["Inbox"], dateAdded: 2 }
  ];

  const actions = detectDuplicateActions(bookmarks);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].id, "new");
  assert.equal(actions[0].action, "delete");
  assert.equal(actions[0].source, "duplicate");
  assert.equal(detectDuplicateActions(bookmarks, { allowDeletion: false }).length, 0);
});

test("parseJsonObjectResponse accepts fenced JSON and repairs surrounding prose", () => {
  assert.deepEqual(parseJsonObjectResponse("```json\n{\"bookmarks\": []}\n```"), { bookmarks: [] });
  assert.deepEqual(parseJsonObjectResponse("Result: [{\"id\":\"1\"}] thanks"), [{ id: "1" }]);
  assert.deepEqual(
    parseJsonObjectResponse("{\"bookmarks\":[{\"id\":\"1\",}],}"),
    { bookmarks: [{ id: "1" }] }
  );
  assert.deepEqual(
    parseJsonObjectResponse('{"r":[{"i":"1","a":"k"},{"i":"2","a":"m","c":"Work"} , {"i":"3"'),
    {
      bookmarks: [
        { i: "1", a: "k" },
        { i: "2", a: "m", c: "Work" }
      ]
    }
  );
  assert.throws(() => parseJsonObjectResponse("{\"bookmarks\":[\"broken]"), /malformed JSON/);
});

test("normalizeModelActions falls back for omitted bookmark ids", () => {
  const bookmarks = [
    { id: "1", title: "One", url: "https://one.example", path: ["Current"] },
    { id: "2", title: "Two", url: "https://two.example", path: ["Current"] }
  ];
  const result = normalizeModelActions({
    bookmarks: [{
      id: "1",
      action: "move",
      title: "One",
      folderPath: ["Learning"],
      reason: "Course reference",
      confidence: 0.9
    }]
  }, bookmarks);

  assert.equal(result[0].folderPath[0], "Learning");
  assert.equal(result[1].action, "keep");
  assert.equal(result[1].source, "fallback");

  const compact = normalizeModelActions({
    r: [
      { i: "1", a: "m", c: "Learning / Documentation" },
      { i: "2", a: "r", n: "Two" }
    ]
  }, bookmarks);
  assert.equal(compact[0].action, "move");
  assert.deepEqual(compact[0].folderPath, ["Learning", "Documentation"]);
  assert.equal(compact[1].action, "rename");
  assert.equal(compact[1].source, "llm");

  const noDelete = normalizeModelActions({
    r: [{ i: "1", a: "d" }]
  }, bookmarks, { allowDeletion: false });
  assert.equal(noDelete[0].action, "keep");
});

test("mergeBookmarkPlans derives rename and move operations", () => {
  const bookmark = {
    id: "1",
    title: "Old title",
    url: "https://example.com",
    path: ["Inbox"]
  };
  const moveResult = mergeBookmarkPlans([bookmark], [], [{
    id: "1",
    action: "move",
    title: "New title",
    folderPath: ["Reference"],
    reason: "Clearer",
    confidence: 0.8,
    source: "llm"
  }]);

  assert.equal(moveResult[0].action, "move");
  assert.equal(moveResult[0].title, "New title");

  const renameResult = mergeBookmarkPlans([bookmark], [], [{
    ...moveResult[0],
    action: "rename",
    folderPath: ["Inbox"]
  }]);
  assert.equal(renameResult[0].action, "rename");
});

test("deduplicateFolderNames excludes Chrome root folders", () => {
  assert.deepEqual(
    deduplicateFolderNames([
      ["Other bookmarks", "Work"],
      ["Bookmarks bar", "Work"],
      ["Mobile bookmarks", "Reading"],
      ["Other bookmarks", "AI Organized", "Reading"]
    ]),
    ["Work", "Reading"]
  );
});

test("chunk rejects invalid sizes and preserves order", () => {
  assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);
  assert.throws(() => chunk([1], 0), /positive integer/);
});

test("validateLocalEndpoint permits only local HTTP servers without credentials", () => {
  assert.equal(
    validateLocalEndpoint("http://localhost:1234/v1/"),
    "http://localhost:1234/v1"
  );
  assert.equal(
    validateLocalEndpoint("http://127.0.0.1:8080/v1"),
    "http://127.0.0.1:8080/v1"
  );
  assert.throws(
    () => validateLocalEndpoint("https://localhost:1234/v1"),
    /must use http/
  );
  assert.throws(
    () => validateLocalEndpoint("http://example.com/v1"),
    /localhost/
  );
  assert.throws(
    () => validateLocalEndpoint("http://user@localhost:1234/v1"),
    /credentials/
  );
});

test("activity log entries are sanitized, formatted, and bounded", () => {
  const entry = createLogEntry("warning", "Retrying smaller batch.", 0);
  assert.equal(entry.level, "warning");
  assert.match(formatLogEntry(entry), /Retrying smaller batch/);

  const logs = Array.from({ length: MAX_LOG_ENTRIES + 10 }, (_, index) => (
    createLogEntry("info", `Entry ${index}`, index)
  )).reduce((current, next) => appendLogEntry(current, next), []);
  assert.equal(logs.length, MAX_LOG_ENTRIES);
  assert.equal(logs[0].message, "Entry 10");
});

test("model classification aborts promptly when cancellation is requested", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });

  const controller = new AbortController();
  const request = classifyBookmarkBatch({
    endpoint: "http://localhost:1234/v1",
    model: "test-model",
    bookmarks: [{
      id: "1",
      title: "Test",
      url: "https://example.com",
      path: []
    }],
    existingCategories: [],
    signal: controller.signal
  });
  controller.abort();

  try {
    await assert.rejects(request, (error) => error.name === "AbortError");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("model classification requests compact JSON with thinking disabled", async () => {
  const previousFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: '{"r":[{"i":"1","a":"k"}]}'
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const result = await classifyBookmarkBatch({
      endpoint: "http://localhost:1234/v1",
      model: "qwen",
      bookmarks: [{
        id: "1",
        title: "Reference",
        url: "https://example.com",
        path: ["Work"]
      }],
      existingCategories: ["Work"]
    });
    assert.equal(requestBody.chat_template_kwargs.enable_thinking, false);
    assert.equal(requestBody.reasoning_effort, "none");
    assert.match(requestBody.messages[1].content, /\/no_think/);
    assert.equal(requestBody.response_format.type, "json_schema");
    assert.equal(result[0].action, "keep");
    assert.equal(result[0].source, "llm");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("model classification blocks delete action when deletion mode is disabled", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: '{"r":[{"i":"1","a":"d"}]}'
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const result = await classifyBookmarkBatch({
      endpoint: "http://localhost:1234/v1",
      model: "qwen",
      bookmarks: [{
        id: "1",
        title: "Reference",
        url: "https://example.com",
        path: ["Work"]
      }],
      existingCategories: ["Work"],
      allowDeletion: false
    });
    assert.equal(result[0].action, "keep");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("local classifier organizes known domains and flags token callbacks", () => {
  const actions = classifyBookmarksLocally([
    {
      id: "1",
      title: "wagih93/repo: AI OCR project",
      url: "https://github.com/wagih93/repo",
      path: ["Other bookmarks"]
    },
    {
      id: "2",
      title: "OAuth callback",
      url: "https://app.example.com/oauth/callback?code=secret",
      path: ["Other bookmarks"]
    },
    {
      id: "3",
      title: "Existing guide",
      url: "https://learn.example.net/guide",
      path: ["Other bookmarks", "Learning"]
    }
  ], ["Learning", "Development"]);

  assert.equal(actions[0].action, "move");
  assert.equal(actions[0].folderPath[0], "AI & Machine Learning");
  assert.equal(actions[0].source, "local");
  assert.equal(actions[1].action, "delete");
  assert.equal(actions[2].action, "keep");
  assert.equal(actions[2].folderPath[0], "Learning");

  const organizationOnly = classifyBookmarksLocally([{
    id: "4",
    title: "OAuth callback",
    url: "https://app.example.com/oauth/callback?code=secret",
    path: ["Other bookmarks"]
  }], ["Development"], "", { allowDeletion: false });
  assert.equal(organizationOnly[0].action, "keep");
});
