import { normalizeModelActions, parseJsonObjectResponse } from "./bookmark-core.js";

export function validateLocalEndpoint(rawEndpoint) {
  const endpoint = new URL(rawEndpoint);
  if (endpoint.protocol !== "http:") {
    throw new Error("The endpoint must use http for a local LLM server.");
  }
  if (!["localhost", "127.0.0.1"].includes(endpoint.hostname)) {
    throw new Error("For privacy, the endpoint must be on localhost or 127.0.0.1.");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("The endpoint must not contain credentials, query parameters, or fragments.");
  }
  return endpoint.toString().replace(/\/$/, "");
}

function abortError() {
  return new DOMException("The local model request was cancelled.", "AbortError");
}

async function requestJson(url, options = {}, timeoutMs = 120_000) {
  let response;
  const timeoutController = new AbortController();
  let timedOut = false;
  const externalSignal = options.signal;
  const abortForCancellation = () => timeoutController.abort();
  externalSignal?.addEventListener("abort", abortForCancellation, { once: true });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs);

  try {
    response = await fetch(url, {
      ...options,
      redirect: "error",
      signal: timeoutController.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      }
    });
    const detail = await response.text();
    if (!response.ok) {
      const error = new Error(`Local LLM request failed (${response.status}): ${detail.slice(0, 280)}`);
      error.status = response.status;
      throw error;
    }
    try {
      return JSON.parse(detail);
    } catch (error) {
      throw new Error("The local LLM returned invalid JSON at the HTTP response layer.", {
        cause: error
      });
    }
  } catch (error) {
    if (error.message?.startsWith("Local LLM request failed")) {
      throw error;
    }
    if (error.message === "The local LLM returned invalid JSON at the HTTP response layer.") {
      throw error;
    }
    if (externalSignal?.aborted) {
      throw abortError();
    }
    if (timedOut) {
      throw new Error(`The local LLM request timed out after ${Math.round(timeoutMs / 1000)} seconds. Retrying with a smaller batch.`, {
        cause: error
      });
    }
    throw new Error(`Cannot reach the local LLM at ${new URL(url).origin}. Start LM Studio or llama.cpp and enable its local server.`, {
      cause: error
    });
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abortForCancellation);
  }
}

export async function discoverModel(endpoint, configuredModel = "") {
  if (configuredModel.trim()) {
    return configuredModel.trim();
  }

  const payload = await requestJson(`${validateLocalEndpoint(endpoint)}/models`);
  const model = payload?.data?.find((entry) => typeof entry.id === "string")?.id;
  if (!model) {
    throw new Error("No loaded local model was returned by /v1/models. Load a model or enter its ID manually.");
  }
  return model;
}

export async function testLocalConnection(endpoint, configuredModel = "") {
  const baseUrl = validateLocalEndpoint(endpoint);
  const model = await discoverModel(baseUrl, configuredModel);
  await requestJson(`${baseUrl}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 16,
      messages: [
        { role: "system", content: "Reply with exactly OK." },
        { role: "user", content: "Connection test" }
      ]
    })
  });
  return model;
}

function buildPrompt(bookmarks, existingCategories, allowDeletion) {
  const actionHint = allowDeletion
    ? 'a is k=keep, m=move, r=rename, d=delete.'
    : 'a is k=keep, m=move, r=rename. Never output d.';
  const deletionHint = allowDeletion
    ? "Use d only for obvious temporary, callback, tracking, duplicate, or unusable links. Keep old but useful bookmarks."
    : "Delete mode is disabled. Keep bookmarks instead of deleting, even if they look temporary.";
  return `/no_think
Classify the bookmark records below. Do not reason in prose.
Return JSON immediately in exactly this compact shape: {"r":[{"i":"ID","a":"k","c":"Optional category","n":"Optional new title"}]}

- Include every input i exactly once.
- ${actionHint}
- For a=m use c as one short category or "Category / Subcategory".
- For a=r use n as a concise title inferred only from the existing title and URL.
- Do not output c or n unless needed.
- Prefer existing category names: ${JSON.stringify(existingCategories)}
- ${deletionHint}
- Prefer m when the current folder is generic or unrelated; use k only when the current folder already fits.
- Never include Chrome root names in c.
- No markdown, explanation, confidence, or repeated URLs.

Input:
${JSON.stringify(bookmarks.map(({ id, title, url, path }) => ({
    i: id,
    t: title.slice(0, 180),
    u: url.slice(0, 420),
    f: path.slice(-2)
  })))}`;
}

function compactResponseSchema(allowDeletion) {
  return {
    name: "bookmark_plan",
    strict: false,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["r"],
      properties: {
        r: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["i", "a"],
            properties: {
              i: { type: "string" },
              a: { type: "string", enum: allowDeletion ? ["k", "m", "r", "d"] : ["k", "m", "r"] },
              c: { type: "string" },
              n: { type: "string" }
            }
          }
        }
      }
    }
  };
}

export async function classifyBookmarkBatch({
  endpoint,
  model,
  bookmarks,
  existingCategories,
  allowDeletion = true,
  signal
}) {
  const basePayload = {
    model,
    reasoning_effort: "none",
    temperature: 0,
    max_tokens: Math.min(2048, Math.max(384, bookmarks.length * 120)),
    stream: false,
    chat_template_kwargs: {
      enable_thinking: false
    },
    messages: [
      {
        role: "system",
        content: "Return only compact valid JSON. Reason silently, disable visible thinking, and never execute changes."
      },
      {
        role: "user",
        content: `${buildPrompt(bookmarks, existingCategories, allowDeletion)}

Important: start the response with { and end it with }. Every string must escape embedded quotes. Finish the entire JSON object immediately.`
      }
    ]
  };
  const completionUrl = `${validateLocalEndpoint(endpoint)}/chat/completions`;
  let payload;
  const {
    chat_template_kwargs,
    reasoning_effort,
    ...portableBasePayload
  } = basePayload;
  const schemaWithoutTemplate = {
    ...portableBasePayload,
    reasoning_effort
  };
  const variants = [
    {
      ...basePayload,
      response_format: {
        type: "json_schema",
        json_schema: compactResponseSchema(allowDeletion)
      }
    },
    {
      ...schemaWithoutTemplate,
      response_format: {
        type: "json_schema",
        json_schema: compactResponseSchema(allowDeletion)
      }
    },
    {
      ...portableBasePayload,
      response_format: {
        type: "json_schema",
        json_schema: compactResponseSchema(allowDeletion)
      }
    },
    {
      ...portableBasePayload,
      response_format: { type: "json_object" }
    },
    {
      ...portableBasePayload,
      response_format: { type: "text" }
    },
    portableBasePayload
  ];

  for (const [index, body] of variants.entries()) {
    try {
      payload = await requestJson(completionUrl, {
        method: "POST",
        body: JSON.stringify(body),
        signal
      });
      break;
    } catch (error) {
      if (error.name === "AbortError") {
        throw error;
      }
      const unsupportedOption = error.status === 400
        || error.status === 422
        || error.status === 501;
      if (!unsupportedOption || index === variants.length - 1) {
        throw error;
      }
    }
  }

  const choice = payload?.choices?.[0];
  const message = choice?.message;
  const content = Array.isArray(message?.content)
    ? message.content.map((part) => part?.text ?? "").join("")
    : message?.content;
  try {
    return normalizeModelActions(parseJsonObjectResponse(content), bookmarks, {
      allowDeletion
    });
  } catch (error) {
    const finishReason = choice?.finish_reason ?? "unknown";
    const contentLength = typeof content === "string" ? content.length : 0;
    const reasoningLength = typeof message?.reasoning_content === "string"
      ? message.reasoning_content.length
      : 0;
    throw new Error(
      `Model output could not be parsed (finish_reason=${finishReason}, content_chars=${contentLength}, reasoning_chars=${reasoningLength}). ${error.message}`,
      { cause: error }
    );
  }
}
