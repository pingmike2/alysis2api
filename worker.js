/**
 * alysis2api — Cloudflare Worker that fronts the Alysis Code Pro gateway.
 *
 * The gateway is an OpenAI-compatible Supabase Edge Function that authenticates
 * a long-lived `slk_…` gateway key and meters free credits server-side.
 *
 * Design constraints established by probing the live gateway (2026-10-09):
 *
 *  1. `GET /v1/models` is PUBLIC — it answers 200 with the allowlist even with no
 *     Authorization header. So the client key cannot be derived from /models.
 *  2. The gateway does NOT accept one uniform wire protocol. It pins a route per
 *     model family:
 *       deepseek-flash, glm-5.3-flash → /v1/chat/completions  (pass-through)
 *       gpt-6-luna                    → /v1/responses        (needs a bridge)
 *       claude-haiku-5-5              → /v1/messages         (needs a bridge)
 *     Sending luna or haiku to /chat/completions returns HTTP 400 with
 *     "Luna uses /v1/responses for reasoning and tools." / "Sonnet uses
 *     /v1/messages for reasoning and tools."
 *  3. The Alysis CLI does not switch protocols for a custom base_url. Protocol
 *     selection lives in `llm/factory.py: resolve_model_protocol()`, which only
 *     fires when `provider_key == "alysis"` — i.e. only for the built-in hosted
 *     preset. A custom profile therefore always speaks plain
 *     /v1/chat/completions. This worker is the only place the split can be
 *     handled, and it keeps the client side on one simple protocol.
 *
 * Everything here is single-account, self-use only: the Alysis Terms of Service
 * §3 forbid reselling or sublicensing hosted-model access or credits, and §2
 * requires one account per person. See README.md.
 */

// ---- protocol bridges (inlined) ----
/**
 * Protocol bridges: OpenAI `/v1/chat/completions` ⇄ Alysis gateway routes.
 *
 * The gateway pins one wire format per model family (probed 2026-10-09):
 *   gpt-6-luna          → /responses   (OpenAI Responses API)
 *   claude-haiku-5-5    → /messages    (Anthropic Messages API)
 *   deepseek/glm flash  → /chat/completions (no bridge needed)
 *
 * The Alysis CLI cannot do this itself: `llm/factory.py: resolve_model_protocol()`
 * only switches transport when `provider_key == "alysis"`, which only the
 * built-in hosted preset has. A custom profile stays on chat/completions, so any
 * luna/haiku request arrives here in chat shape and must be translated.
 *
 * Everything below is a pure function of its input — no env, no fetch — so the
 * whole translation layer is unit-testable without spending credits.
 */

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Flatten OpenAI content (string or array of typed parts) into plain text. */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (part.type === "output_text" || part.type === "input_text" || part.type === "text") {
        return typeof part.text === "string" ? part.text : "";
      }
      return "";
    })
    .join("");
}

/** OpenAI chat tool → flat Responses tool (name/parameters are top level). */
function toFlatFunction(tool) {
  const fn = tool && typeof tool === "object" && tool.function ? tool.function : tool || {};
  const out = { type: "function", name: fn.name };
  if (fn.description != null) out.description = fn.description;
  out.parameters = fn.parameters || { type: "object", properties: {} };
  return out;
}

/** OpenAI chat tool → Anthropic tool (input_schema instead of parameters). */
function toAnthropicTool(tool) {
  const fn = tool && typeof tool === "object" && tool.function ? tool.function : tool || {};
  const out = { name: fn.name };
  if (fn.description != null) out.description = fn.description;
  out.input_schema = fn.parameters || { type: "object", properties: {} };
  return out;
}

function mapToolChoice(choice) {
  if (choice == null) return undefined;
  if (typeof choice === "string") {
    if (choice === "required") return "required";
    return choice; // "auto" | "none"
  }
  if (typeof choice === "object" && choice.function && choice.function.name) {
    return { type: "function", name: choice.function.name };
  }
  return undefined;
}

/** Emit `data: <json>\n\n` SSE frames. */
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = "data: [DONE]\n\n";

function newStreamState(model) {
  return {
    id: `chatcmpl-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
    created: Math.floor(Date.now() / 1000),
    model: model || "unknown",
    roleSent: false,
    finished: false,
    toolIndex: new Map(),
    nextToolIndex: 0,
  };
}

function chatChunk(state, delta, finishReason, usage) {
  const payload = {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  };
  if (usage) payload.usage = usage;
  return sse(payload);
}

/** Ensure the very first delta carries `role`, which some clients require. */
function roleDelta(state) {
  if (state.roleSent) return "";
  state.roleSent = true;
  return chatChunk(state, { role: "assistant", content: "" });
}

// ---------------------------------------------------------------------------
// chat/completions → /responses   (gpt-6-luna)
// ---------------------------------------------------------------------------

function chatToResponses(body, model) {
  const input = [];
  let instructions = null;

  for (const msg of body.messages || []) {
    const role = msg && msg.role;

    if (role === "system" || role === "developer") {
      const text = textOf(msg.content);
      if (text) instructions = instructions ? `${instructions}\n\n${text}` : text;
      continue;
    }

    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: textOf(msg.content),
      });
      continue;
    }

    if (role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const text = textOf(msg.content);
      if (text) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      for (const call of msg.tool_calls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function && call.function.name,
          arguments: (call.function && call.function.arguments) || "",
        });
      }
      continue;
    }

    const assistant = role === "assistant";
    input.push({
      type: "message",
      role: assistant ? "assistant" : "user",
      content: [
        { type: assistant ? "output_text" : "input_text", text: textOf(msg.content) },
      ],
    });
  }

  const payload = {
    model: model || body.model,
    input,
    stream: Boolean(body.stream),
  };
  if (instructions) payload.instructions = instructions;
  if (Array.isArray(body.tools) && body.tools.length) {
    payload.tools = body.tools.map(toFlatFunction);
  }
  const choice = mapToolChoice(body.tool_choice);
  if (choice !== undefined) payload.tool_choice = choice;
  const maxOut = body.max_completion_tokens != null ? body.max_completion_tokens : body.max_tokens;
  if (maxOut != null) payload.max_output_tokens = maxOut;
  if (body.reasoning_effort) payload.reasoning = { effort: body.reasoning_effort };
  return payload;
}

/** Responses object → chat.completion body. */
function responsesToChatBody(data, model) {
  const state = newStreamState(model || (data && data.model));
  const output = (data && data.output) || [];
  let content = "";
  const reasoning = [];
  const toolCalls = [];

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message") {
      for (const part of item.content || []) {
        if (part && part.type === "output_text" && typeof part.text === "string") {
          content += part.text;
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id || item.id,
        type: "function",
        function: { name: item.name, arguments: item.arguments || "" },
      });
    } else if (item.type === "reasoning") {
      // Reasoning normally arrives only as encrypted_content, which cannot be
      // decrypted here. Prefer a plaintext summary when the gateway sends one.
      for (const part of item.summary || []) {
        if (part && typeof part.text === "string") reasoning.push(part.text);
      }
    }
  }

  const inTok = (data && data.usage && data.usage.input_tokens) || 0;
  const outTok = (data && data.usage && data.usage.output_tokens) || 0;
  const cached = (data && data.usage && data.usage.input_tokens_details && data.usage.input_tokens_details.cached_tokens) || 0;
  const reasoningTok =
    (data && data.usage && data.usage.output_tokens_details && data.usage.output_tokens_details.reasoning_tokens) || 0;

  const message = { role: "assistant", content: content || null };
  if (reasoning.length) message.reasoning_content = reasoning.join("\n\n");
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: state.id,
    object: "chat.completion",
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: inTok,
      completion_tokens: outTok,
      total_tokens: (data && data.usage && data.usage.total_tokens) || inTok + outTok,
      prompt_tokens_details: { cached_tokens: cached },
      completion_tokens_details: { reasoning_tokens: reasoningTok },
    },
  };
}

/** Stream of `/responses` SSE events → stream of chat.completion chunks. */
function responsesSseToChatSse(upstreamBody) {
  const state = newStreamState(upstreamBody.model);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  // item_id → chat tool_call index, so argument fragments land on the right call
  const toolIndexByItem = new Map();
  const pendingByItem = new Map();

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let split;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        let type = "";
        const dataLines = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) type = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length || dataLines[0] === "[DONE]") continue;
        let data;
        try {
          data = JSON.parse(dataLines.join("\n"));
        } catch {
          continue;
        }
        if (!type) type = data.type || "";

        switch (type) {
          case "response.created":
          case "response.in_progress":
            controller.enqueue(encoder.encode(roleDelta(state)));
            break;

          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta":
            controller.enqueue(
              encoder.encode(
                chatChunk(state, { reasoning_content: data.delta || "" }),
              ),
            );
            break;

          case "response.output_text.delta":
            controller.enqueue(
              encoder.encode(chatChunk(state, { content: data.delta || "" })),
            );
            break;

          case "response.output_item.added": {
            const item = data.item || {};
            if (item.type === "function_call") {
              const index = state.nextToolIndex++;
              toolIndexByItem.set(item.id, index);
              pendingByItem.set(item.id, "");
              controller.enqueue(
                encoder.encode(
                  roleDelta(state) +
                    chatChunk(state, {
                      tool_calls: [
                        {
                          index,
                          id: item.call_id || item.id,
                          type: "function",
                          function: { name: item.name, arguments: "" },
                        },
                      ],
                    }),
                ),
              );
            }
            break;
          }

          case "response.function_call_arguments.delta": {
            const itemId = data.item_id;
            if (itemId == null) break;
            const index = toolIndexByItem.get(itemId);
            if (index === undefined) break;
            pendingByItem.set(itemId, (pendingByItem.get(itemId) || "") + (data.delta || ""));
            controller.enqueue(
              encoder.encode(
                chatChunk(state, {
                  tool_calls: [{ index, function: { arguments: data.delta || "" } }],
                }),
              ),
            );
            break;
          }

          case "response.function_call_arguments.done": {
            const itemId = data.item_id;
            const index = itemId != null ? toolIndexByItem.get(itemId) : undefined;
            const target = index === undefined ? 0 : index;
            const sent = (itemId != null && pendingByItem.get(itemId)) || "";
            const full = typeof data.arguments === "string" ? data.arguments : sent;
            // Only emit a catch-up delta when the fragments seen so far are a
            // strict prefix of the authoritative final arguments.
            if (full.startsWith(sent) && full.length > sent.length) {
              controller.enqueue(
                encoder.encode(
                  chatChunk(state, {
                    tool_calls: [{ index: target, function: { arguments: full.slice(sent.length) } }],
                  }),
                ),
              );
            }
            break;
          }

          case "response.completed": {
            const resp = data.response || {};
            const usage = resp.usage;
            const inTok = (usage && usage.input_tokens) || 0;
            const outTok = (usage && usage.output_tokens) || 0;
            const cached =
              (usage && usage.input_tokens_details && usage.input_tokens_details.cached_tokens) || 0;
            const reasoningTok =
              (usage && usage.output_tokens_details && usage.output_tokens_details.reasoning_tokens) || 0;
            const finish = toolIndexByItem.size > 0 ? "tool_calls" : "stop";
            controller.enqueue(
              encoder.encode(
                chatChunk(
                  state,
                  {},
                  finish,
                  {
                    prompt_tokens: inTok,
                    completion_tokens: outTok,
                    total_tokens: (usage && usage.total_tokens) || inTok + outTok,
                    prompt_tokens_details: { cached_tokens: cached },
                    completion_tokens_details: { reasoning_tokens: reasoningTok },
                  },
                ) + DONE,
              ),
            );
            state.finished = true;
            break;
          }

          case "response.failed":
          case "error":
            controller.enqueue(
              encoder.encode(
                sse({
                  error: {
                    message: (data.error && data.error.message) || data.message || "upstream error",
                    type: (data.error && data.error.type) || "server_error",
                  },
                }),
              ),
            );
            controller.enqueue(encoder.encode(DONE));
            state.finished = true;
            break;

          default:
            break;
        }
      }
    },
    flush(controller) {
      // Upstream closed without response.completed — still terminate the stream
      // so the client does not hang waiting for [DONE].
      if (!state.finished) {
        controller.enqueue(
          encoder.encode(
            chatChunk(state, {}, toolIndexByItem.size > 0 ? "tool_calls" : "stop") + DONE,
          ),
        );
      }
    },
  });
}

// ---------------------------------------------------------------------------
// chat/completions → /messages   (claude-haiku-5-5)
// ---------------------------------------------------------------------------

function chatToMessages(body, model) {
  const messages = [];
  let system = null;

  const push = (role, content) => {
    // Anthropic requires strictly alternating user/assistant turns; tool results
    // arrive as several consecutive `tool` messages, so merge them.
    const last = messages[messages.length - 1];
    if (last && last.role === role && Array.isArray(content) && Array.isArray(last.content)) {
      last.content.push(...content);
      return;
    }
    messages.push({ role, content });
  };

  for (const msg of body.messages || []) {
    const role = msg && msg.role;

    if (role === "system" || role === "developer") {
      const text = textOf(msg.content);
      if (text) system = system ? `${system}\n\n${text}` : text;
      continue;
    }

    if (role === "tool") {
      push("user", [
        { type: "tool_result", tool_use_id: msg.tool_call_id, content: textOf(msg.content) },
      ]);
      continue;
    }

    if (role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const blocks = [];
      const text = textOf(msg.content);
      if (text) blocks.push({ type: "text", text });
      for (const call of msg.tool_calls) {
        let input = {};
        try {
          input = JSON.parse((call.function && call.function.arguments) || "{}");
        } catch {
          input = {};
        }
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.function && call.function.name,
          input,
        });
      }
      push("assistant", blocks);
      continue;
    }

    push(role === "assistant" ? "assistant" : "user", textOf(msg.content));
  }

  const maxTokens =
    body.max_completion_tokens != null
      ? body.max_completion_tokens
      : body.max_tokens != null
        ? body.max_tokens
        : 8192;

  const payload = {
    model: model || body.model,
    // max_tokens is REQUIRED by the Messages API; never omit it.
    max_tokens: maxTokens,
    messages,
    stream: Boolean(body.stream),
  };
  if (system) payload.system = system;
  if (Array.isArray(body.tools) && body.tools.length) {
    payload.tools = body.tools.map(toAnthropicTool);
  }
  const choice = mapToolChoice(body.tool_choice);
  if (choice !== undefined) payload.tool_choice = choice;
  return payload;
}

/** Messages object → chat.completion body. */
function messagesToChatBody(data, model) {
  const state = newStreamState(model || (data && data.model));
  const blocks = (data && data.content) || [];
  let content = "";
  const reasoning = [];
  const toolCalls = [];

  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      content += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input == null ? {} : block.input),
        },
      });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      reasoning.push(block.thinking);
    }
  }

  const inTok = (data && data.usage && data.usage.input_tokens) || 0;
  const outTok = (data && data.usage && data.usage.output_tokens) || 0;
  const cacheCreate =
    (data && data.usage && data.usage.cache_creation_input_tokens) || 0;
  const cacheRead = (data && data.usage && data.usage.cache_read_input_tokens) || 0;

  const message = { role: "assistant", content: content || null };
  if (reasoning.length) message.reasoning_content = reasoning.join("\n\n");
  if (toolCalls.length) message.tool_calls = toolCalls;

  const stopReason = (data && data.stop_reason) || null;
  let finish = "stop";
  if (stopReason === "tool_use") finish = "tool_calls";
  else if (stopReason === "max_tokens") finish = "length";
  else if (stopReason === "stop_sequence") finish = "stop";
  if (toolCalls.length) finish = "tool_calls";

  return {
    id: state.id,
    object: "chat.completion",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: {
      prompt_tokens: inTok,
      completion_tokens: outTok,
      total_tokens: inTok + outTok,
      prompt_tokens_details: { cached_tokens: cacheRead + cacheCreate },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

/** Stream of `/messages` SSE events → stream of chat.completion chunks. */
function messagesSseToChatSse(upstreamBody) {
  const state = newStreamState(upstreamBody.model);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  // Anthropic block index → chat tool_call index (tool_use blocks only)
  const toolIndexByBlock = new Map();
  const sentByBlock = new Map();
  let nextToolIndex = 0;

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let split;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        let type = "";
        const dataLines = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) type = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;
        const raw = dataLines.join("\n");
        if (raw === "[DONE]") continue;
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          continue;
        }
        if (!type) type = data.type || "";

        switch (type) {
          case "message_start":
            controller.enqueue(encoder.encode(roleDelta(state)));
            break;

          case "content_block_start": {
            const block = data.content_block || {};
            if (block.type === "tool_use") {
              const index = nextToolIndex++;
              toolIndexByBlock.set(data.index, index);
              sentByBlock.set(data.index, "");
              controller.enqueue(
                encoder.encode(
                  roleDelta(state) +
                    chatChunk(state, {
                      tool_calls: [
                        {
                          index,
                          id: block.id,
                          type: "function",
                          function: { name: block.name, arguments: "" },
                        },
                      ],
                    }),
                ),
              );
            }
            break;
          }

          case "content_block_delta": {
            const delta = data.delta || {};
            if (delta.type === "text_delta") {
              controller.enqueue(
                encoder.encode(chatChunk(state, { content: delta.text || "" })),
              );
            } else if (delta.type === "thinking_delta") {
              controller.enqueue(
                encoder.encode(
                  chatChunk(state, { reasoning_content: delta.thinking || "" }),
                ),
              );
            } else if (delta.type === "input_json_delta") {
              const index = toolIndexByBlock.get(data.index);
              if (index === undefined) break;
              const partial = delta.partial_json || "";
              sentByBlock.set(data.index, (sentByBlock.get(data.index) || "") + partial);
              controller.enqueue(
                encoder.encode(
                  chatChunk(state, {
                    tool_calls: [{ index, function: { arguments: partial } }],
                  }),
                ),
              );
            }
            break;
          }

          case "message_delta": {
            const delta = data.delta || {};
            const stopReason = delta.stop_reason;
            let finish = "stop";
            if (stopReason === "tool_use") finish = "tool_calls";
            else if (stopReason === "max_tokens") finish = "length";
            else if (toolIndexByBlock.size > 0) finish = "tool_calls";
            const usage = data.usage;
            const inTok = (usage && usage.input_tokens) || 0;
            const outTok = (usage && usage.output_tokens) || 0;
            const cacheRead = (usage && usage.cache_read_input_tokens) || 0;
            const cacheCreate = (usage && usage.cache_creation_input_tokens) || 0;
            controller.enqueue(
              encoder.encode(
                chatChunk(state, {}, finish, {
                  prompt_tokens: inTok,
                  completion_tokens: outTok,
                  total_tokens: inTok + outTok,
                  prompt_tokens_details: { cached_tokens: cacheRead + cacheCreate },
                  completion_tokens_details: { reasoning_tokens: 0 },
                }),
              ),
            );
            break;
          }

          case "message_stop":
            controller.enqueue(encoder.encode(DONE));
            state.finished = true;
            break;

          case "error":
            controller.enqueue(
              encoder.encode(
                sse({
                  error: {
                    message: (data.error && data.error.message) || "upstream error",
                    type: (data.error && data.error.type) || "server_error",
                  },
                }) + DONE,
              ),
            );
            state.finished = true;
            break;

          default:
            break;
        }
      }
    },
    flush(controller) {
      if (!state.finished) {
        controller.enqueue(
          encoder.encode(
            chatChunk(state, {}, toolIndexByBlock.size > 0 ? "tool_calls" : "stop") + DONE,
          ),
        );
      }
    },
  });
}

const PROXY_VERSION = "1.1.0";

/** Gateway allowlist. Kept in sync with GET /v1/models; /models proxies live. */
const MODEL_ROUTES = {
  "deepseek-flash": "chat/completions",
  "glm-5.3-flash": "chat/completions",
  "gpt-6-luna": "responses",
  "claude-haiku-5-5": "messages",
};

const DEFAULT_MODELS = ["deepseek-flash", "glm-5.3-flash"];

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "x-alysis2api-version": PROXY_VERSION,
      ...(init.headers || {}),
    },
  });

function upstreamError(message, status = 400, type = "invalid_request_error") {
  return json(
    { error: { message, type, code: type } },
    { status },
  );
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Fixed secret used by the Alysis CLI — replaces the real gateway key. */
function checkClientKey(request, env) {
  const expected = env.CLIENT_API_KEY;
  if (!expected) return "CLIENT_API_KEY is not set on this worker.";
  const header = request.headers.get("authorization") || "";
  const got = header.replace(/^Bearer\s+/i, "").trim();
  if (got !== expected) return "invalid client api key";
  return null;
}

function gatewayBase(env) {
  return (env.GATEWAY_BASE_URL || "").replace(/\/+$/, "");
}

/** Mirror the upstream allowlist, optionally tagging which models need a bridge. */
async function handleModels(env) {
  const base = gatewayBase(env);
  if (!base) return upstreamError("GATEWAY_BASE_URL is not set on this worker.", 500, "server_error");
  let models = [];
  try {
    const res = await fetch(`${base}/models`, { headers: { accept: "application/json" } });
    if (res.ok) {
      const payload = await res.json().catch(() => null);
      const list = Array.isArray(payload) ? payload : payload && payload.data;
      if (Array.isArray(list)) {
        models = list
          .map((m) => (typeof m === "string" ? m : m && m.id))
          .filter((id) => typeof id === "string" && id.length > 0);
      }
    }
  } catch {
    /* fall through to the pinned list */
  }
  if (models.length === 0) models = [...DEFAULT_MODELS];
  return json({
    object: "list",
    data: models.map((id) => ({
      id,
      object: "model",
      owned_by: "alysis",
      // Non-standard, additive field: tells callers which ids this worker
      // forwards as-is vs. which ones it translates to a different wire format.
      alysis_route: MODEL_ROUTES[id] || "chat/completions",
    })),
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health" || path === "/") {
      return json({
        ok: true,
        version: PROXY_VERSION,
        upstream: gatewayBase(env) || null,
        gateway_key_configured: Boolean(env.GATEWAY_API_KEY),
        client_key_configured: Boolean(env.CLIENT_API_KEY),
        bridged_models: Object.entries(MODEL_ROUTES)
          .filter(([, route]) => route !== "chat/completions")
          .map(([id]) => id),
      });
    }

    if (path === "/v1/models" || path === "/models") {
      return handleModels(env);
    }

    const authError = checkClientKey(request, env);
    if (authError) {
      return upstreamError(authError, authError.startsWith("invalid") ? 401 : 500, "invalid_api_key");
    }

    const upstreamKey = env.GATEWAY_API_KEY;
    if (!upstreamKey) {
      return upstreamError("GATEWAY_API_KEY is not set on this worker.", 500, "server_error");
    }

    if (request.method !== "POST") {
      return upstreamError(`method ${request.method} is not supported`, 405, "invalid_request_error");
    }

    const body = await readJson(request);
    if (!body) return upstreamError("request body must be JSON");

    const model = String(body.model || "").trim();
    const route = MODEL_ROUTES[model];
    if (!route) {
      return upstreamError(
        `unknown model "${model}". Available: ${Object.keys(MODEL_ROUTES).join(", ")}`,
      );
    }

    // route "responses" (gpt-6-luna) and "messages" (claude-haiku-5-5) are
    // translated here; the client always sees chat/completions shape back.
    const bridged = route === "responses" || route === "messages";
    const upstreamPayload = route === "responses"
      ? chatToResponses(body, model)
      : route === "messages"
        ? chatToMessages(body, model)
        : body;

    // Forward verbatim. Content-length is set by fetch; do not copy hop-by-hop
    // headers or the client's own Authorization.
    const headers = {
      "content-type": "application/json",
      accept: request.headers.get("accept") || "text/event-stream",
      authorization: `Bearer ${upstreamKey}`,
      "user-agent": "alysis-code/0.1.0",
    };
    if (request.headers.get("x-alysis-client")) {
      headers["x-alysis-client"] = request.headers.get("x-alysis-client");
    }

    const upstreamUrl = `${gatewayBase(env)}/${route}`;
    // IMPORTANT: stringify before sending. Passing a plain JS object as `body`
    // makes this gateway answer 400 "Invalid hosted JSON request. Send a UTF-8
    // JSON object." — verified by replaying all four variants from a Worker:
    // object body -> 400, JSON.stringify(body) -> 200. Supabase Edge Function
    // request parsing does not accept the object form over Worker fetch.
    const payload = JSON.stringify(upstreamPayload);
    const init = { method: "POST", headers, body: payload };
    if (body.stream) {
      let res;
      try {
        res = await fetch(upstreamUrl, init);
      } catch (err) {
        return upstreamError(`upstream fetch failed: ${err && err.message}`, 502, "server_error");
      }
      if (!res.ok) {
        return json(await res.text().then((t) => t || "{}").catch(() => "{}"), { status: res.status });
      }
      const streamBody = route === "responses"
        ? res.body.pipeThrough(responsesSseToChatSse({ model }))
        : route === "messages"
          ? res.body.pipeThrough(messagesSseToChatSse({ model }))
          : res.body;
      return new Response(streamBody, {
        status: res.status,
        headers: {
          "content-type": res.headers.get("content-type") || "text/event-stream",
          "cache-control": "no-cache",
          "x-alysis2api-version": PROXY_VERSION,
        },
      });
    }

    let res;
    try {
      res = await fetch(upstreamUrl, init);
    } catch (err) {
      return upstreamError(`upstream fetch failed: ${err && err.message}`, 502, "server_error");
    }
    let text = await res.text();
    if (bridged && res.ok) {
      try {
        const data = JSON.parse(text);
        const chat = route === "responses"
          ? responsesToChatBody(data, model)
          : messagesToChatBody(data, model);
        text = JSON.stringify(chat);
      } catch {
        // Leave an unparseable upstream body untouched rather than inventing one.
      }
    }
    const outHeaders = {
      // Preserve the upstream content-type verbatim. Wrapping the body would
      // break OpenAI compatibility for the client.
      "content-type": res.headers.get("content-type") || "application/json",
      "x-alysis2api-version": PROXY_VERSION,
    };
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) outHeaders["retry-after"] = retryAfter;
    return new Response(text, { status: res.status, headers: outHeaders });
  },
};